process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// api/tts.js — Workar natural voice (OpenAI TTS), only for signed-in users
// Needs these in Vercel → Settings → Environment Variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  // 1) Check the Supabase sign-in token sent from the browser
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) {
    return res.status(401).json({ error: "sign in required", detail: "no token sent" });
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OPENAI_API_KEY) {
    return res.status(500).json({ error: "server env vars missing" });
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) {
    return res.status(401).json({ error: "sign in required", detail: "token rejected" });
  }

  // 2) Turn the text into speech
  const { text, voice = "alloy" } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text is required" });
  }

  const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice,
      input: text.slice(0, 4000),
      response_format: "mp3",
    }),
  });

  if (!ttsRes.ok) {
    const err = await ttsRes.text();
    return res.status(502).json({ error: "tts failed", detail: err });
  }

  const audio = Buffer.from(await ttsRes.arrayBuffer());
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(audio);
}
