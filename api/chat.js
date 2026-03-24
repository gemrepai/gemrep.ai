// api/chat.js
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const MASTER_EMAIL = 'tomcrowhurst@proton.me';

// Allowed models — only these can be requested from the client
const ALLOWED_MODELS = {
  'claude-haiku-4-5-20251001': true,
  'claude-sonnet-4-20250514': true,
};
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── 1. Auth check ──────────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  // ── 2. Master account bypass ───────────────────────────────────────────
  const isMaster = user.email === MASTER_EMAIL;
  if (!isMaster) {
    // Load profile + check limits for non-master users
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('plan, subscription_status, messages_used, messages_limit')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      // No profile = new user on free tier, create one on the fly
      await supabase.from('profiles').insert({
        id: user.id,
        email: user.email,
        plan: 'free',
        subscription_status: 'active',
        messages_used: 0,
        messages_limit: 50,
      });
    } else {
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
    }
  }

  // ── 3. Proxy to Anthropic ──────────────────────────────────────────────
  const body = req.body;

  // Model: use client-requested model if it's in the allowlist, otherwise default
  const requestedModel = body.model && ALLOWED_MODELS[body.model] ? body.model : DEFAULT_MODEL;

  // Build Anthropic request — pass through temperature if provided
  const anthropicBody = {
    model: requestedModel,
    max_tokens: body.max_tokens || 400,
    system: body.system,
    messages: body.messages,
  };

  // Only include temperature if explicitly set (Anthropic default is 1.0)
  if (typeof body.temperature === 'number') {
    anthropicBody.temperature = body.temperature;
  }

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (err) {
    console.error('Anthropic fetch error:', err);
    return res.status(502).json({ error: 'upstream_error' });
  }

  const data = await response.json();
  if (!response.ok) {
    return res.status(response.status).json(data);
  }

  // ── 4. Increment usage (non-master only) ───────────────────────────────
  if (!isMaster) {
    await supabase
      .from('profiles')
      .update({ messages_used: supabase.sql`messages_used + 1`, updated_at: new Date().toISOString() })
      .eq('id', user.id);
  }

  res.status(200).json({ ...data, _usage: { master: isMaster } });
}
