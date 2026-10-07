process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
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
const TICKET_TOOL = {
  name: 'create_support_ticket',
  description: 'Pass the conversation to the Workar support team. Use it when the person needs a human: refunds or payment problems, payouts, a technical problem, a complaint about a mentor or client, account changes, or anything you cannot answer from the information you have. Before calling it, make sure you know what the problem is and, if they are not signed in, their email address. Ask for these politely if missing.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['category', 'summary'],
    properties: {
      category: { type: 'string', enum: ['refund_or_payment', 'payout', 'technical_problem', 'booking_or_session', 'complaint', 'account', 'mentor_application', 'other'] },
      summary: { type: 'string', description: 'Two or three sentences in English for the support team: what happened, what the person wants, and any booking details they gave.' },
      email: { type: 'string', description: 'Their email address if they are not signed in.' },
      urgent: { type: 'boolean', description: 'True if a paid session is within the next 24 hours or money was taken by mistake.' }
    }
  }
};
const CAT_LABEL = { refund_or_payment: 'Refund or payment', payout: 'Mentor payout', technical_problem: 'Technical problem', booking_or_session: 'Booking or session', complaint: 'Complaint', account: 'Account', mentor_application: 'Mentor application', other: 'Other' };

// What the help desk may know about a signed-in person: their own bookings only.
async function accountContext(me) {
  const prof = (await M.rows(`profiles?id=eq.${encodeURIComponent(me.id)}&select=id,name,role,timezone,aiCredits,approved`))[0] || {};
  const field = prof.role === 'mentor' ? 'mentorId' : 'clientId';
  const reqs = await M.rows(`requests?${field}=eq.${encodeURIComponent(me.id)}&select=*&order=createdAt.desc&limit=6`);
  const ids = [...new Set(reqs.map(r => prof.role === 'mentor' ? r.clientId : r.mentorId))].filter(Boolean);
  const names = {};
  if (ids.length) (await M.rows(`profiles?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,name`)).forEach(p => { names[p.id] = p.name; });
  const bookings = reqs.map(r => ({
    with: names[prof.role === 'mentor' ? r.clientId : r.mentorId] || 'unknown',
    package: r.packageKey, status: r.status, paid: !!r.paid,
    time: r.startsAt ? M.when(r, prof.timezone) : 'not scheduled yet',
    sessionsDone: r.sessionsDone || 0,
    callLinkReady: !!r.meetingUrl,
    awaiting: r.status === 'pending' ? 'the mentor to accept or decline' : (r.status === 'accepted' && !r.paid && r.amountCents > 0 ? 'the client to pay' : '')
  }));
  return { name: prof.name, role: prof.role, email: me.email, mentorApproved: prof.role === 'mentor' ? prof.approved !== false : undefined, aiCreditsLeft: prof.aiCredits, bookings };
}

async function createTicket(input, me, ctx, messages) {
  const id = 'WK-' + Date.now().toString(36).toUpperCase().slice(-6);
  const email = (me && me.email) || String(input.email || '').trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, note: 'No valid email address. Ask the person for their email before creating the ticket.' };
  const ticket = {
    id, email, userId: me ? me.id : null, name: (ctx && ctx.name) || null,
    category: input.category || 'other', summary: String(input.summary || '').slice(0, 1500), urgent: !!input.urgent,
    status: 'open', transcript: messages.filter(m => typeof m.content === 'string').slice(-12)
  };
  const ins = await fetch(`${process.env.SUPABASE_URL}/rest/v1/support_tickets`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(ticket)
  }).catch(() => null);
  if (!ins || !ins.ok) console.error('ticket-save-failed', ins && ins.status); // the email below still reaches the team
  const chat = ticket.transcript.map(m => `<b>${m.role === 'user' ? M.esc(ticket.name || 'Visitor') : 'Assistant'}:</b> ${M.esc(m.content).slice(0, 600)}`).join('<br>');
  const adminEmail = process.env.ADMIN_EMAIL || 'naeimeh.alaghehband@gmail.com';
  // To the team: reply straight from your inbox and it goes to the person.
  await M.sendMail(adminEmail, `${ticket.urgent ? '[URGENT] ' : ''}Support ${id}: ${CAT_LABEL[ticket.category] || 'Other'}`, M.layout(`Support request ${id}`, [
    `<b>From:</b> ${M.esc(ticket.name || 'Visitor')} &lt;${M.esc(email)}&gt;${ctx && ctx.role ? ' (' + M.esc(ctx.role) + ')' : ''}`,
    `<b>Category:</b> ${M.esc(CAT_LABEL[ticket.category] || 'Other')}${ticket.urgent ? ' &nbsp;<b style="color:#A65A48">Urgent</b>' : ''}`,
    `<b>Summary:</b> ${M.esc(ticket.summary)}`,
    ctx && ctx.bookings && ctx.bookings.length ? `<b>Their bookings:</b>` + M.list(ctx.bookings.map(x => `${x.with}: ${x.status}${x.paid ? ', paid' : ''}, ${x.time}`)) : '',
    `<b>Conversation</b><br>${chat}`,
    `<span style="font-size:13px;color:#8a7461;">Reply to this email to answer ${M.esc(ticket.name || 'them')} directly.</span>`
  ]), [], { replyTo: email });
  // To the person: confirmation with their reference number.
  await M.sendMail(email, `We received your request (${id})`, M.layout('Thank you for contacting Workar', [
    `Dear ${M.esc((ticket.name || '').split(' ')[0] || 'Workar member')},`,
    `Thank you for reaching out. Your request has been passed to our support team under reference <b>${id}</b>.`,
    `<b>Summary:</b> ${M.esc(ticket.summary)}`,
    `We aim to reply within one business day${ticket.urgent ? ', and sooner for urgent session or payment matters' : ''}. You can simply reply to this email to add any details.`,
    'Kind regards,<br>The Workar team'
  ]));
  return { ok: true, id, email };
}

async function help(req, res, b) {
  const messages = cleanTurns(b.messages, 16, 1500);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Please type a question first.' });
  const me = await M.userFromToken(bearer(req)).catch(() => null);
  let ctx = null;
  if (me) { try { ctx = await accountContext(me); } catch (e) { console.error('help-ctx', e.message); } }
  let prices = '';
  try {
    const st = await M.rows('site_settings?id=eq.main&select=data');
    const pk = st[0] && st[0].data && Array.isArray(st[0].data.packages) ? st[0].data.packages : null;
    if (pk) prices = '\n\nCurrent package base prices (at the minimum session rate, USD): ' + pk.filter(p => !p.hidden).map(p => `${p.key}: $${p.price}${p.sessions ? ' for ' + p.sessions + ' session(s)' : ''}`).join('; ');
  } catch (e) {}
  const system = `You are Workar's support assistant on workar.me, a career mentorship platform. You help visitors, clients and mentors with how Workar works, their bookings, payments, calls, refunds and becoming a mentor.

How you work:
- Answer from the information below and, when available, from the person's own account details. Be specific: if they ask about "my session", use their bookings (who it is with, the time, whether it is paid, what it is waiting for).
- If the person needs a human (refund or payment problems, payouts, technical problems, complaints, account changes, or anything you cannot answer), offer to pass it to the support team and use create_support_ticket. Confirm the problem first; if they are not signed in, politely ask for their email address. After the ticket is created, give them the reference number and say they will receive a confirmation email and a reply within one business day.
- Never promise refunds, exceptions or outcomes; the support team decides. Never reveal anything about other people's accounts.
- For career advice, kindly point them to a mentor or the AI coach.
- Reply in the language the person writes in. Keep answers to 2 to 5 sentences, plain text, no markdown. When useful, mention where to click on the site (for example: My profile, then the booking card).

${ctx ? 'The person is signed in. Their account (private, only for answering them):\n' + JSON.stringify(ctx) : 'The person is not signed in.'}

${KNOWLEDGE}${prices}`;
  let reply = '', ticket = null;
  for (let round = 0; round < 3; round++) {
    const data = await AI.callClaude({ system, messages, tools: [TICKET_TOOL], maxTokens: 600, timeoutMs: 20000 });
    const uses = data.content.filter(x => x.type === 'tool_use');
    const text = AI.textOf(data);
    if (data.stop_reason !== 'tool_use' || !uses.length) { reply = text; break; }
    messages.push({ role: 'assistant', content: data.content });
    const results = [];
    for (const u of uses) {
      const out = ticket ? { ok: true, id: ticket.id, note: 'Already created in this conversation.' } : await createTicket(u.input || {}, me, ctx, messages);
      if (out.ok) ticket = out;
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
    if (text) reply = text;
  }
  return res.status(200).json({ reply: reply || 'Thank you. How else may I help you?', ticket: ticket ? { id: ticket.id } : null });
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


// =====================================================================
// 7. Reply helper (inbox): drafts a courteous reply the user edits and sends
// =====================================================================
async function replyDraft(req, res, b) {
  const me = await M.userFromToken(bearer(req));
  if (!me) return res.status(401).json({ error: 'Please sign in again.' });
  const [mine, other] = await Promise.all([M.fullProfile(me.id), b.otherId ? M.fullProfile(String(b.otherId)) : Promise.resolve({})]);
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-14).map(m => ({ from: m.from === 'me' ? 'me' : 'them', text: String(m.text || '').slice(0, 800) }));
  const data = await AI.callClaude({
    system: `You help a user of Workar, a career mentorship platform, write a reply in a direct-message chat.
The user is a ${mine.role === 'mentor' ? 'mentor' : 'client looking for career guidance'}; the other person is a ${other.role === 'mentor' ? 'mentor' : 'client'} named ${String(other.name || 'them').split(' ')[0]}.
Write one short, warm, professional reply (1 to 4 sentences) in the user's voice that answers the latest message from "them".
If the chat is empty, write a friendly opening message that fits the two profiles. If the user has started a draft, improve and complete it, keeping its meaning.
Never promise outcomes, never invent facts, times or prices, and never ask for payment or contact details outside Workar.
Write in the same language as the conversation (English if unclear). Plain text only. Return only the message.`,
    messages: [{ role: 'user', content: JSON.stringify({ me: { name: mine.name, role: mine.role, headline: mine.headline || mine.profession }, them: { name: other.name, role: other.role, headline: other.headline || other.profession }, conversation: msgs, myDraft: String(b.draft || '').slice(0, 1000) }) }],
    maxTokens: 350, timeoutMs: 15000
  });
  return res.status(200).json({ reply: AI.textOf(data).trim() });
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
      case 'reply_draft': return await replyDraft(req, res, b);
      default: return res.status(400).json({ error: 'Unknown task' });
    }
  } catch (e) {
    console.error('agents-error', b.task, e);
    return res.status(500).json({ error: 'The assistant hit an error. Try again in a moment.', detail: String(e.message || e) });
  }
};
