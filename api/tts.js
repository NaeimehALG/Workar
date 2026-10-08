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

  const { SUPABASE_URL, OPENAI_API_KEY } = process.env;
  // the publishable key is public (it is in index.html), so it is a safe fallback
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_publishable_QB6yw8JdxxI7ODorT3X3aw_rJa2UXbq";
  if (!SUPABASE_URL || !OPENAI_API_KEY) {
    return res.status(500).json({ error: "server env vars missing" });
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) {
    return res.status(401).json({ error: "sign in required", detail: "token rejected" });
  }
  const me = await userRes.json().catch(() => ({}));
  // Guest (anonymous) visitors use the free browser voice; the paid voice is for real accounts only.
  if (!me || !me.id || me.is_anonymous) {
    return res.status(401).json({ error: "account required" });
  }

  // Daily cap per user so the OpenAI credit can't be drained (admin is unlimited).
  const ADMIN = (process.env.ADMIN_EMAIL || "naeimeh.alaghehband@gmail.com").toLowerCase();
  const DAILY_LIMIT = Number(process.env.TTS_DAILY_LIMIT) || 60;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if ((me.email || "").toLowerCase() !== ADMIN && SERVICE) {
    const sh = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    try {
      const c = await fetch(`${SUPABASE_URL}/rest/v1/agent_events?kind=eq.tts&ref=eq.${encodeURIComponent(me.id)}&createdAt=gte.${encodeURIComponent(since)}&select=id`,
        { method: "HEAD", headers: Object.assign({ Prefer: "count=exact" }, sh) });
      const used = Number(((c.headers.get("content-range") || "").split("/")[1]) || 0);
      if (used >= DAILY_LIMIT) return res.status(429).json({ error: "daily voice limit reached" });
      await fetch(`${SUPABASE_URL}/rest/v1/agent_events`, {
        method: "POST", headers: Object.assign({ Prefer: "return=minimal" }, sh),
        body: JSON.stringify({ id: `tts_${me.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, kind: "tts", ref: me.id }),
      });
    } catch (e) { /* never block the voice because of the counter */ }
  }

  // 2) Turn the text into speech: a warm, natural voice (gpt-4o-mini-tts), falling back to tts-1
  const { text, lang } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text is required" });
  }
  const input = text.slice(0, 1500);
  const instructions = lang === "fa"
    ? "Speak natural, fluent Persian (Farsi) in a soft, delicate and graceful young woman's voice, like a kind career coach talking gently with one person: light and airy tone, a soft smile in the voice, calm unhurried pace, natural pauses. Gentle and elegant, never loud, never robotic, never flat."
    : "Speak in a soft, delicate and graceful young woman's voice, like a kind career coach talking gently with one person on a video call: light and airy tone, a soft smile in the voice, calm unhurried pace, small natural pauses. Gentle and elegant, never loud, never robotic, never flat, not over-the-top cheerful.";
  const call = (body) => fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let ttsRes = await call({ model: "gpt-4o-mini-tts", voice: "nova", input, instructions, response_format: "mp3" });
  if (!ttsRes.ok) ttsRes = await call({ model: "tts-1-hd", voice: "nova", input, response_format: "mp3" });

  if (!ttsRes.ok) {
    const err = await ttsRes.text();
    return res.status(502).json({ error: "tts failed", detail: err });
  }

  const audio = Buffer.from(await ttsRes.arrayBuffer());
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(audio);
}
