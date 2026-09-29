// Vercel Serverless Function: natural, expressive voice for the AI mock interview.
// FREE option (recommended): Microsoft Azure Speech, free tier F0 = 0.5 million characters per month.
//   Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (e.g. canadacentral) in Vercel -> Settings -> Environment Variables.
// Paid option: OpenAI gpt-4o-mini-tts, set OPENAI_API_KEY. Azure is used first when both are set.
// Only signed-in Workar users can use it (checked against Supabase).

function escXml(s) { return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); }

async function azureTts(text, lang) {
  const key = process.env.AZURE_SPEECH_KEY, region = process.env.AZURE_SPEECH_REGION;
  const voice = lang === 'fa' ? 'fa-IR-DilaraNeural' : 'en-US-JennyNeural';
  const inner = lang === 'fa'
    ? `<prosody rate="-4%">${escXml(text)}</prosody>`
    : `<mstts:express-as style="friendly" styledegree="1.2"><prosody rate="-3%">${escXml(text)}</prosody></mstts:express-as>`;
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang === 'fa' ? 'fa-IR' : 'en-US'}"><voice name="${voice}">${inner}</voice></speak>`;
  return fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'workar' },
    body: ssml
  });
}

async function openaiTts(text, lang) {
  const instructions = lang === 'fa'
    ? 'Speak Persian (Farsi) with a natural Tehrani accent in a soft, gentle, calm voice, like a kind and supportive interviewer. Speak a little slowly and quietly, never loud or sharp, with a warm smile in the voice and relaxed, natural pauses between sentences.'
    : 'Speak in a soft, gentle, calm voice, like a kind and supportive American hiring manager in a relaxed conversation. General American accent. Speak a little slowly and softly, never loud, sharp or overly energetic. Keep a warm smile in the voice, with natural pauses between sentences. Never sound robotic or like you are reading.';
  return fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'shimmer', input: text, instructions, response_format: 'mp3' })
  });
}

module.exports = async (req, res) => {
  const hasAzure = !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
  const hasOpenai = !!process.env.OPENAI_API_KEY;
  if (req.method === 'GET') {
    // quick health check: open https://workar.me/api/tts in a browser
    const out = { tts: 'deployed', azure: hasAzure, openaiKey: hasOpenai, supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) };
    // https://workar.me/api/tts?test=1 -> really asks OpenAI for one word, to show whether the key and credit work
    if ((req.query && req.query.test) || /[?&]test=1/.test(req.url || '')) {
      try {
        const r = hasAzure ? await azureTts('OK.', 'en') : hasOpenai ? await openaiTts('OK.', 'en') : null;
        if (!r) out.test = 'no voice service configured';
        else if (r.ok) out.test = 'WORKS - natural voice is ready';
        else { const t = await r.text(); out.test = 'FAILED ' + r.status; out.reason = t.slice(0, 300); }
      } catch (e) { out.test = 'FAILED'; out.reason = String(e).slice(0, 300); }
    }
    res.status(200).json(out);
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!hasAzure && !hasOpenai) { res.status(501).json({ error: 'no voice service configured' }); return; }

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

  try {
    let r = hasAzure ? await azureTts(text, lang) : await openaiTts(text, lang);
    if (!r.ok && hasAzure && hasOpenai) r = await openaiTts(text, lang); // Azure free quota used up -> OpenAI
    if (!r.ok) { res.status(502).json({ error: 'tts-error', detail: await r.text() }); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
