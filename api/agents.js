// Workar AI agents, one route for all of them (keeps the number of Vercel functions low):
//   POST /api/agents { task: "onboard" }        mentor onboarding assistant (fills the mentor form)
//   POST /api/agents { task: "followup_draft" } drafts an after-session action plan from the mentor's notes
//   POST /api/agents { task: "followup_send" }  sends the reviewed plan to the client (message + email)
//   POST /api/agents { task: "help" }           help desk for visitors, clients and mentors
//   POST /api/agents { task: "match" }          AI mentor matching (public)
//   POST /api/agents { task: "request_note" }   helps a client write their booking note
//   POST /api/agents { task: "profile_review" } profile coach for mentors
//   GET  /api/agents                            health check
// Env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY (all already set)
const M = require('./_mail');
const AI = require('./_ai');
const KNOWLEDGE = require('./_knowledge');

const MAX_MSG = 40, MAX_CHARS = 12000;

function body(req) { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } } return b || {}; }
function cleanTurns(list, maxTurns, maxChars) {
  let msgs = (Array.isArray(list) ? list : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, maxChars) }))
    .slice(-maxTurns);
  while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
  return msgs;
}
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// =====================================================================
// 1. Mentor onboarding assistant
// =====================================================================
const FIELDS = ['Technology & Data', 'Business & Management', 'Finance & Accounting', 'Engineering', 'Healthcare & Life Sciences', 'Marketing & Sales', 'Design & Creative', 'Education & Research', 'Law & Public Sector', 'Operations & Trades', 'Other'];
const SENIORITY = ['early-career', 'mid-level', 'senior', 'lead-or-manager', 'executive'];
const HELPS_WITH = ['resume_review', 'interview_prep', 'career_switch', 'job_search_strategy', 'salary_negotiation', 'promotion_and_growth', 'leadership', 'newcomer_career_start', 'certification_prep', 'portfolio_review', 'linkedin_and_networking'];
const REQUIRED = ['headline', 'profession', 'yearsExperience', 'bio', 'languages', 'skills', 'helpsWith'];

const ONBOARD_TOOL = {
  name: 'update_profile_draft',
  description: 'Save or change fields of the mentor profile. Call it every time the mentor gives you information, including right after they paste a CV or LinkedIn summary. Include only fields you are setting or changing. Arrays replace the previous value.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      headline: { type: 'string', description: 'One line, max 90 characters, e.g. "Senior data analyst helping career switchers break into analytics".' },
      profession: { type: 'string', description: 'Current job title, e.g. "Data Analyst".' },
      yearsExperience: { type: 'integer', minimum: 0, maximum: 60 },
      bio: { type: 'string', description: 'First-person bio, 60 to 120 words, in the mentor\'s voice, only facts they gave.' },
      languages: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'Languages they can mentor in, in English, e.g. ["English","Persian"].' },
      education: { type: 'string', description: 'Highest or most relevant degree(s), one line.' },
      certifications: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      skills: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Concrete skills, tools or specialties.' },
      helpsWith: { type: 'array', items: { type: 'string', enum: HELPS_WITH }, maxItems: 6 },
      field: { type: 'string', enum: FIELDS },
      seniority: { type: 'string', enum: SENIORITY },
      industries: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      idealMentee: { type: 'string', description: 'One or two sentences on who they help best.' }
    }
  }
};

function onboardSystem(draft, missing) {
  return `You are the onboarding assistant for Workar (workar.me), a career mentorship platform. A new mentor is filling in their profile form, and you fill the form for them through a short, courteous conversation using the update_profile_draft tool. Whatever you save appears in their form right away; they review it and submit it themselves.

How to run the chat:
- Ask one or two questions at a time. Keep each reply under 70 words. Plain text only: no markdown, no asterisks, no bullet symbols.
- Cover: what they do and for how long, education and certifications, what they can help mentees with, who they help best, which languages they can mentor in, and their key skills.
- If they paste a CV or LinkedIn summary, extract everything you can, save it immediately, then ask only about what's missing.
- Call update_profile_draft whenever you learn something. Choose the categories yourself; don't read category lists to them.
- Never invent facts: no employers, degrees, certifications, numbers or achievements they didn't give you. Ask when unsure.
- Chat in the language the mentor writes in. Write the profile fields in English unless the mentor asks for another language.
- The bio is first person, warm and specific, 60 to 120 words.
- When nothing required is missing, thank them, and politely ask them to review the form, add their name and LinkedIn, choose their session rate, and submit it. Offer to change anything; apply changes with the tool.

Rules:
- Each mentor sets their own session rate in the rate section of the form, with a Workar minimum. Don't suggest a specific price.
- Weekly availability is set in the dashboard after the profile is approved. Don't collect it here.
- Workar reviews every mentor profile before it goes public.
- Stay on the topic of their mentor profile.

Current form values (JSON): ${JSON.stringify(draft)}
Still missing: ${missing.length ? missing.join(', ') : 'nothing required'}`;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
function strArr(v, maxItems, maxLen, allowed) {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set(), out = [];
  for (const it of v) {
    const s = str(it, maxLen);
    if (!s || seen.has(s.toLowerCase()) || (allowed && !allowed.includes(s))) continue;
    seen.add(s.toLowerCase()); out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}
function applyDraft(draft, input) {
  const next = Object.assign({}, draft);
  if (!input || typeof input !== 'object') return next;
  const set = (k, v) => { if (v !== undefined && v !== '') next[k] = v; };
  set('headline', str(input.headline, 90));
  set('profession', str(input.profession, 80));
  if (Number.isInteger(input.yearsExperience) && input.yearsExperience >= 0 && input.yearsExperience <= 60) next.yearsExperience = input.yearsExperience;
  set('bio', str(input.bio, 1500));
  set('languages', strArr(input.languages, 6, 30));
  set('education', str(input.education, 200));
  set('certifications', strArr(input.certifications, 8, 80));
  set('skills', strArr(input.skills, 10, 50));
  set('helpsWith', strArr(input.helpsWith, 6, 40, HELPS_WITH));
  if (FIELDS.includes(input.field)) next.field = input.field;
  if (SENIORITY.includes(input.seniority)) next.seniority = input.seniority;
  set('industries', strArr(input.industries, 5, 50));
  set('idealMentee', str(input.idealMentee, 300));
  return next;
}
const missingOf = d => REQUIRED.filter(k => { const v = d[k]; return Array.isArray(v) ? !v.length : (v === undefined || v === null || v === ''); });

async function onboard(req, res, b) {
  const me = await M.userFromToken(bearer(req));
  if (!me) return res.status(401).json({ error: 'Sign in to use the assistant.' });
  if (Array.isArray(b.messages) && b.messages.length > MAX_MSG) return res.status(400).json({ error: 'This chat is long. Press "Start over" to begin again.' });
  const messages = cleanTurns(b.messages, MAX_MSG, MAX_CHARS);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Send a message first.' });
  let draft = applyDraft({}, b.draft || {});
  let reply = '';
  for (let round = 0; round < 5; round++) {
    const data = await AI.callClaude({ system: onboardSystem(draft, missingOf(draft)), messages, tools: [ONBOARD_TOOL], maxTokens: 1500 });
    const uses = data.content.filter(x => x.type === 'tool_use');
    const text = AI.textOf(data);
    if (data.stop_reason !== 'tool_use' || !uses.length) { reply = text; break; }
    messages.push({ role: 'assistant', content: data.content });
    messages.push({ role: 'user', content: uses.map(u => { draft = applyDraft(draft, u.input); const miss = missingOf(draft); return { type: 'tool_result', tool_use_id: u.id, content: `Saved to the form. Still missing: ${miss.length ? miss.join(', ') : 'nothing required'}.` }; }) });
    if (text) reply = text;
  }
  const missing = missingOf(draft);
  if (!reply) reply = missing.length ? 'Got it. Tell me a bit more so I can finish your profile.' : 'Your form is filled in. Check it, add your name, LinkedIn and session rate, then submit.';
  return res.status(200).json({ reply, draft, missing, ready: !missing.length });
}

// =====================================================================
// 2. Follow-up agent (mentor notes -> action plan the mentor reviews, then sends)
// =====================================================================
async function loadOwnRequest(req, b) {
  const me = await M.userFromToken(bearer(req));
  if (!me) return { error: [401, 'Sign in first.'] };
  const r = (await M.rows(`requests?id=eq.${encodeURIComponent(b.requestId || '')}&select=*`))[0];
  if (!r) return { error: [404, 'Booking not found.'] };
  if (r.mentorId !== me.id) return { error: [403, 'Only the mentor of this booking can send a follow-up.'] };
  if (r.amountCents > 0 && !r.paid) return { error: [400, 'This booking is not paid yet.'] };
  return { me, r };
}

async function followupDraft(req, res, b) {
  const { error, r } = await loadOwnRequest(req, b);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const notes = String(b.notes || '').trim().slice(0, 4000);
  if (notes.length < 10) return res.status(400).json({ error: 'Write a few notes from the session first.' });
  const [mentor, client] = await Promise.all([M.fullProfile(r.mentorId), M.fullProfile(r.clientId)]);
  const data = await AI.callClaude({
    system: `You turn a mentor's rough notes from a career mentoring session into a short follow-up message the mentor will send to their client.
Write it in the mentor's voice (first person), addressed to the client by first name, in a courteous, professional tone. Plain text, no markdown symbols.
Structure: one polite opening line thanking them for the session; "What we covered:" with 2 to 4 short lines; "Your next steps:" as a numbered list of 3 to 5 concrete actions with rough timing; one closing line inviting them to book the next session or message with questions.
Use only what is in the notes and the client's stated goals. Never invent facts, numbers or promises. Under 220 words.
Write in the same language as the mentor's notes.`,
    messages: [{ role: 'user', content: JSON.stringify({ mentorName: mentor.name, clientFirstName: String(client.name || '').split(' ')[0], clientGoal: client.profession || client.targetField || '', clientGoals: client.goals || [], mentorNotes: notes }) }],
    maxTokens: 800
  });
  return res.status(200).json({ draft: AI.textOf(data) });
}

async function followupSend(req, res, b) {
  const { error, me, r } = await loadOwnRequest(req, b);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const text = String(b.text || '').trim().slice(0, 4000);
  if (text.length < 10) return res.status(400).json({ error: 'The message is empty.' });
  const msgId = 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ins = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ id: msgId, requestId: r.id, senderId: me.id, text, createdAt: new Date().toISOString() })
  });
  if (!ins.ok) return res.status(500).json({ error: 'Could not save the message.', detail: await ins.text() });
  await M.patch(`requests?id=eq.${encodeURIComponent(r.id)}`, { followupSentAt: new Date().toISOString() }).catch(() => {});
  const [mentor] = await Promise.all([M.profile(r.mentorId)]);
  const html = M.layout(`Your plan from ${mentor.name}`, [M.esc(text).replace(/\n/g, '<br>'), 'Enjoyed the session? A short review helps other people find a good mentor.'], { text: 'Open Workar', url: M.SITE() + '/?go=dashboard' });
  await M.sendMail(await M.emailOf(r.clientId), `Your next steps from ${mentor.name}`, html);
  return res.status(200).json({ ok: true });
}

// =====================================================================
// 3. Help desk
// =====================================================================
async function help(req, res, b) {
  const messages = cleanTurns(b.messages, 12, 1500);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Ask a question first.' });
  let prices = '';
  try {
    const st = await M.rows('site_settings?id=eq.main&select=data');
    const pk = st[0] && st[0].data && Array.isArray(st[0].data.packages) ? st[0].data.packages : null;
    if (pk) prices = '\n\nCurrent package base prices (at the minimum session rate, USD): ' + pk.filter(p => !p.hidden).map(p => `${p.key}: $${p.price}${p.sessions ? ' for ' + p.sessions + ' session(s)' : ''}`).join('; ');
  } catch (e) {}
  const data = await AI.callClaude({
    system: `You are Workar's help desk assistant on workar.me. Answer questions from visitors, clients and mentors about how Workar works, booking, payments, calls, refunds and becoming a mentor.
Answer only from the information below. If the answer isn't there, or the person needs something done on their account (a refund, a payout, a bug, a complaint about a person), politely explain that the support team can help with that and ask them to email support@workar.me with their booking details.
Never promise a refund or make exceptions to policy. Don't give career advice here; point them to the AI coach or a mentor instead.
Reply in the language the person writes in. Keep answers short: 2 to 5 sentences, plain text, no markdown.

${KNOWLEDGE}${prices}`,
    messages, maxTokens: 500, timeoutMs: 20000
  });
  return res.status(200).json({ reply: AI.textOf(data) });
}

// =====================================================================
// 4. Mentor matching (server builds the mentor list, so the prompt can't be misused)
// =====================================================================
async function match(req, res, b) {
  const q = String(b.query || '').trim().slice(0, 800);
  if (q.length < 5) return res.status(400).json({ error: 'Describe what you need in a sentence or two.' });
  const all = await M.rows('profiles?role=eq.mentor&select=*');
  const mentors = all.filter(p => p.approved !== false).slice(0, 300).map(p => ({
    id: p.id, profession: p.profession || '', headline: p.headline || '', yearsExperience: p.experience || '',
    skills: (p.skills || []).slice(0, 8), languages: p.languages || [], helpsWith: p.helpsWith || [],
    field: p.field || '', seniority: p.seniority || '', bestFor: p.idealMentee || '', bio: String(p.bio || '').slice(0, 260)
  }));
  if (!mentors.length) return res.status(200).json({ matches: [] });
  const out = await AI.askJSON(
    `You match people with career mentors on Workar. Pick up to 3 mentors who best fit the person's situation.
Prefer mentors whose experience, "helpsWith" and languages fit. If the person writes in a language a mentor speaks, that's a plus.
For each pick, give one short sentence (max 25 words) explaining the fit, written to the person ("They...").
Write the reasons in the same language the person wrote in. Never invent facts about mentors.
Return: [{"id":"...","reason":"..."}]. Return [] if nobody fits.`,
    JSON.stringify({ person: q, mentors }), { maxTokens: 600, timeoutMs: 20000 });
  const ids = new Set(mentors.map(m => m.id));
  const matches = (Array.isArray(out) ? out : []).filter(m => m && ids.has(m.id)).slice(0, 3).map(m => ({ id: m.id, reason: String(m.reason || '').slice(0, 300) }));
  return res.status(200).json({ matches });
}

// =====================================================================
// 5. Booking note helper (client): turns a rough goal into a clear request for the mentor
// =====================================================================
async function requestNote(req, res, b) {
  const me = await M.userFromToken(bearer(req));
  if (!me) return res.status(401).json({ error: 'Sign in first.' });
  const rough = String(b.text || '').trim().slice(0, 1500);
  const [client, mentor] = await Promise.all([M.fullProfile(me.id), b.mentorId ? M.fullProfile(String(b.mentorId)) : Promise.resolve({})]);
  const data = await AI.callClaude({
    system: `You help a client write the note that goes with a session request to a career mentor on Workar.
Write 2 to 4 short sentences in first person: where they are now, what they want from this session, and one specific thing they'd like help with.
Use only what's given. If the rough text is empty or very short, write a good note from their profile and keep it general. Never invent employers, numbers or facts.
Write in the same language as the rough text (or English if it's empty). Plain text only. Return only the note.`,
    messages: [{ role: 'user', content: JSON.stringify({ roughText: rough, client: { targetRole: client.profession, currentRole: client.currentProfession, careerStage: client.careerStage, goals: client.goals, aboutTheirGoal: client.bio }, mentor: { profession: mentor.profession, headline: mentor.headline }, package: b.packageKey || '' }) }],
    maxTokens: 400, timeoutMs: 15000
  });
  return res.status(200).json({ note: AI.textOf(data) });
}

// =====================================================================
// 6. Profile coach (mentor): honest suggestions to get more bookings
// =====================================================================
async function profileReview(req, res, b) {
  const me = await M.userFromToken(bearer(req));
  if (!me) return res.status(401).json({ error: 'Sign in first.' });
  const p = await M.fullProfile(me.id);
  if (p.role !== 'mentor') return res.status(403).json({ error: 'This is for mentor profiles.' });
  const reviews = await M.rows(`reviews?mentorId=eq.${encodeURIComponent(me.id)}&select=rating,text&limit=20`);
  const out = await AI.askJSON(
    `You review a mentor's profile on Workar, a career mentorship marketplace, and help them get more bookings.
Be specific and honest, and kind. Base everything on the profile; never invent achievements.
Return {"score": 1-10 for how convincing the profile is to a client, "strengths": up to 2 short strings,
"suggestions": 3 short, concrete improvements, "headline": a stronger headline under 90 characters using only their facts,
"bio": an improved first-person bio of 60-120 words using only their facts}.
Write in the same language as their bio.`,
    JSON.stringify({ headline: p.headline, profession: p.profession, yearsExperience: p.experience, bio: p.bio, skills: p.skills, languages: p.languages, education: p.education, certifications: p.certifications, helpsWith: p.helpsWith, sessionRate: p.sessionRate, hasLinkedIn: !!p.linkedin, reviewCount: reviews.length, averageRating: reviews.length ? (reviews.reduce((a, r) => a + (Number(r.rating) || 0), 0) / reviews.length).toFixed(1) : null }),
    { maxTokens: 900, timeoutMs: 25000 });
  return res.status(200).json({
    score: Math.max(1, Math.min(10, Number(out.score) || 5)),
    strengths: (out.strengths || []).slice(0, 2).map(String),
    suggestions: (out.suggestions || []).slice(0, 3).map(String),
    headline: String(out.headline || '').slice(0, 90),
    bio: String(out.bio || '').slice(0, 1500)
  });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const ok = !!(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
    return res.status(ok ? 200 : 500).json({ ok, model: AI.MODEL(), note: ok ? 'Workar agents are ready' : 'Missing environment variables' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const b = body(req);
  try {
    switch (b.task) {
      case 'onboard': return await onboard(req, res, b);
      case 'followup_draft': return await followupDraft(req, res, b);
      case 'followup_send': return await followupSend(req, res, b);
      case 'help': return await help(req, res, b);
      case 'match': return await match(req, res, b);
      case 'request_note': return await requestNote(req, res, b);
      case 'profile_review': return await profileReview(req, res, b);
      default: return res.status(400).json({ error: 'Unknown task' });
    }
  } catch (e) {
    console.error('agents-error', b.task, e);
    return res.status(500).json({ error: 'The assistant hit an error. Try again in a moment.', detail: String(e.message || e) });
  }
};
