// api/stt.js — Deepgram speech-to-text proxy
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const MASTER_EMAIL = 'tomcrowhurst@proton.me';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb', // Allow audio uploads up to 5MB
    },
  },
};

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

  // ── 2. Get audio data ──────────────────────────────────────────────────
  // Expects raw audio binary in the request body with appropriate Content-Type
  const contentType = req.headers['content-type'] || 'audio/webm';

  // For JSON body with base64 audio
  let audioBuffer;
  if (contentType.includes('application/json')) {
    const { audio, mimetype } = req.body;
    if (!audio) {
      return res.status(400).json({ error: 'no_audio', message: 'No audio data provided' });
    }
    audioBuffer = Buffer.from(audio, 'base64');
  } else {
    // Raw binary body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    audioBuffer = Buffer.concat(chunks);
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    return res.status(400).json({ error: 'empty_audio' });
  }

  // ── 3. Send to Deepgram ────────────────────────────────────────────────
  const dgApiKey = process.env.DEEPGRAM_API_KEY;
  if (!dgApiKey) {
    return res.status(500).json({ error: 'deepgram_not_configured' });
  }

  try {
    const dgResponse = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Token ' + dgApiKey,
          'Content-Type': contentType.includes('application/json') ? 'audio/webm' : contentType,
        },
        body: audioBuffer,
      }
    );

    if (!dgResponse.ok) {
      const errText = await dgResponse.text();
      console.error('Deepgram error:', dgResponse.status, errText);
      return res.status(502).json({ error: 'deepgram_error', status: dgResponse.status });
    }

    const dgData = await dgResponse.json();

    // Extract transcript from Deepgram response
    const transcript = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    const confidence = dgData?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;

    res.status(200).json({
      transcript: transcript,
      confidence: confidence,
    });
  } catch (err) {
    console.error('Deepgram fetch error:', err);
    return res.status(502).json({ error: 'upstream_error' });
  }
}
