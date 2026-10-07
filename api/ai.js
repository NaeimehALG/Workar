process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Serverless Function: the AI coach (resume, career, mock interview).
// Keeps the Anthropic key server-side, requires a signed-in Workar account,
// and uses one AI credit per message (the admin is unlimited).
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const M = require('./_mail');

const START_CREDITS = 5; // matches the free credits given to new accounts in index.html

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { turns, prompt } = body || {};

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' }); return; }

  const me = await M.userFromToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!me || me.is_anonymous) { res.status(401).json({ error: 'sign-in-required' }); return; }

  const adminEmail = (process.env.ADMIN_EMAIL || 'naeimeh.alaghehband@gmail.com').toLowerCase();
  const isAdmin = (me.email || '').toLowerCase() === adminEmail;
  const prof = (await M.rows(`profiles?id=eq.${encodeURIComponent(me.id)}&select=aiCredits`))[0];
  if (!prof && !isAdmin) { res.status(401).json({ error: 'profile-required' }); return; }
  let credits = prof && prof.aiCredits != null ? Number(prof.aiCredits) : START_CREDITS;
  if (!isAdmin && credits <= 0) { res.status(402).json({ error: 'no-credits', aiCreditsRemaining: 0 }); return; }

  try {
    const messages = (Array.isArray(turns) && turns.length
      ? turns.map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: String(t.content || '').slice(0, 12000) }))
      : [{ role: 'user', content: String(prompt || '').slice(0, 12000) }]).slice(-40);
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length) { res.status(400).json({ error: 'empty' }); return; }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 1000, messages })
    });
    if (!r.ok) { res.status(502).json({ error: 'anthropic-error', detail: await r.text() }); return; }
    const data = await r.json();
    const text = (data.content || []).map(b => b.text || '').join('\n');

    let remaining = null;
    if (!isAdmin && prof) {
      remaining = Math.max(0, credits - 1);
      await M.patch(`profiles?id=eq.${encodeURIComponent(me.id)}`, { aiCredits: remaining });
    }
    res.status(200).json({ text, aiCreditsRemaining: remaining });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
