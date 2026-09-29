// Vercel Serverless Function: natural, expressive voice for the AI mock interview.
// Uses OpenAI's gpt-4o-mini-tts. Set OPENAI_API_KEY in Vercel -> Settings -> Environment Variables.
// Only signed-in Workar users can use it (checked against Supabase), so strangers can't run up your bill.

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    // quick health check: open https://workar.me/api/tts in a browser
    res.status(200).json({ tts: 'deployed', openaiKey: !!process.env.OPENAI_API_KEY, supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(501).json({ error: 'OPENAI_API_KEY is not set' }); return; }

  // --- who is asking? (must be a signed-in Workar user) ---
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const supabaseUrl = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !supabaseUrl || !serviceKey) { res.status(401).json({ error: 'sign in required' }); return; }
  try {
    const u = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${token}` } });
    if (!u.ok) { res.status(401).json({ error: 'sign in required' }); return; }
  } catch (e) { res.status(401).json({ error: 'sign in required' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const text = String((body && body.text) || '').slice(0, 1500).trim();
  const lang = (body && body.lang) === 'fa' ? 'fa' : 'en';
  if (!text) { res.status(400).json({ error: 'no text' }); return; }

  const instructions = lang === 'fa'
    ? 'Speak Persian (Farsi) with a natural Tehrani accent, like a warm, friendly, experienced interviewer in a real conversation. Relaxed pace, genuine interest, encouraging tone, natural pauses between sentences.'
    : 'Speak like a warm, friendly, experienced American hiring manager in a real, relaxed conversation. General American accent. Natural pace with small pauses between sentences, genuine interest and encouragement when reacting to the answer, then a slightly more thoughtful tone when asking the next question. Never sound robotic or like you are reading.';

  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'coral', input: text, instructions, response_format: 'mp3' })
    });
    if (!r.ok) { res.status(502).json({ error: 'tts-error', detail: await r.text() }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
