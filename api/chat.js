import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Your email — always gets full access regardless of subscription status
const MASTER_EMAIL = 'gemrepai@proton.me';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── 1. Auth check ─────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  // ── 2. Master key bypass ──────────────────────────────────────────
  const isMaster = user.email === MASTER_EMAIL;

  // ── 3. Load profile + check limits (skip for master) ─────────────
  if (!isMaster) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan, subscription_status, messages_used, messages_limit')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'profile_not_found' });
    }

    const isActive = profile.subscription_status === 'active' || profile.plan === 'free';
    if (!isActive) {
      return res.status(403).json({ error: 'subscription_inactive', plan: profile.plan });
    }

    if (profile.messages_used >= profile.messages_limit) {
      return res.status(429).json({
        error: 'limit_reached',
        used: profile.messages_used,
        limit: profile.messages_limit,
        plan: profile.plan,
      });
    }

    // Increment usage
    await supabase
      .from('profiles')
      .update({ messages_used: profile.messages_used + 1, updated_at: new Date().toISOString() })
      .eq('id', user.id);
  }

  // ── 4. Proxy to Anthropic ─────────────────────────────────────────
  const body = req.body;
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: body.max_tokens || 400,
        system: body.system,
        messages: body.messages,
      }),
    });
  } catch (err) {
    console.error('Anthropic fetch error:', err);
    return res.status(502).json({ error: 'upstream_error' });
  }

  const data = await response.json();
  if (!response.ok) return res.status(response.status).json(data);

  res.status(200).json({ ...data, _master: isMaster });
}
