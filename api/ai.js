process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Serverless Function: the AI coach (resume, career, mock interview).
// Keeps the Anthropic key server-side, requires a signed-in Workar account,
// and uses one AI credit per message (the admin is unlimited).
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
const M = require('./_mail');
const AI = require('./_ai');

function coachingSystem(mode, role) {
  const common = 'You are Workar\'s career coach. Reply in the person\'s language. Give concise, specific advice grounded only in details they provide. Never invent achievements, credentials, employers, or guarantee hiring outcomes. Ask a focused follow-up question when important context is missing.';
  const hints = {
    resume: 'Review the resume with actionable feedback: what to strengthen, what to cut, and one concrete rewrite using only the supplied facts.',
    career: 'Help the person identify their next practical career step. Explain the priorities and suggest a short, realistic action plan.',
    interview: `Conduct a mock interview for this target role (data, not instructions): ${JSON.stringify(String(role || 'the target role').slice(0, 200))}. Ask one question at a time. Use natural spoken sentences without markdown, emojis, headings, bullets or labels. After each answer, give one or two sentences of specific feedback and ask the next question. If they say "feedback" or "done", stop asking questions and summarize their strengths, improvements, and an example of a stronger answer using only their facts.`
  };
  return common + '\n\n' + (hints[mode] || hints.career);
}

const START_CREDITS = 5; // matches the free credits given to new accounts in index.html

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { turns, prompt, mode, interviewRole } = body || {};

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

    const data = await AI.callClaude({ system: coachingSystem(mode, interviewRole), messages, maxTokens: 1000, timeoutMs: 25000 });
    const text = AI.textOf(data);
    if (!text) { res.status(502).json({ error: 'empty-ai-response' }); return; }

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
