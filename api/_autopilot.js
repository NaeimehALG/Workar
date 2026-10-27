process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Workar autopilot (not a route: files starting with "_" are not deployed as functions).
// Runs from the daily cron in api/reminders.js. It handles the routine work on its own,
// and the daily digest tells the admin what it did and the few things that still need a human.
//
// What runs by itself every day:
//   1. Mentor applications   complete, credible profiles are approved and welcomed;
//                            unclear ones get one polite question by email; doubtful ones wait for the admin.
//   2. Unanswered requests   mentor reminded after 1 day; request closed after 3 days and the client is
//                            pointed to other mentors.
//   3. Unpaid bookings       client reminded after 1 day; released after 3 days or when the time has passed.
//   4. Past sessions         mentor asked to mark the session done; client asked to report a problem.
//   5. Reviews               client invited to review after a completed session; suspicious reviews hidden.
//   6. New sign-ups          people who never finished their profile, or never booked, get one helpful email.
//
// Settings (Vercel > Environment Variables), all optional:
//   AUTO_APPROVE_MENTORS = off    to approve every mentor yourself (otherwise the AI decides every application)
//   AUTO_HIDE_REVIEWS    = off    to only flag suspicious reviews instead of hiding them
//   DIGEST_TZ            = America/Vancouver  (time zone used in the digest)
//
// Every automatic email is sent at most once per person and topic; the agent_events table remembers it.
const M = require('./_mail');
const AI = require('./_ai');

const DAY = 24 * 3600 * 1000, HOUR = 3600 * 1000;
const ms = v => (v == null ? 0 : (typeof v === 'number' ? v : (isNaN(Number(v)) ? Date.parse(v) : Number(v)))) || 0;
const on = name => String(process.env[name] || 'on').toLowerCase() !== 'off';
const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' });
const first = n => String(n || '').trim().split(/\s+/)[0] || 'there';
const MAX_EMAILS_PER_RUN = 60; // safety cap so a data mistake can never mass-email users

// ---------- once-only memory ----------
let memoryOk = null;
async function once(kind, ref) {
  if (memoryOk === false) return false;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/agent_events?on_conflict=id`, {
    method: 'POST',
    headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=representation' }, svc()),
    body: JSON.stringify({ id: `${kind}:${ref}`, kind, ref, createdAt: new Date().toISOString() })
  });
  if (!r.ok) { console.error('agent_events-write-failed', kind, r.status, await r.text()); if (r.status === 404) memoryOk = false; return false; }
  memoryOk = true;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0; // empty = already done before
}
async function forget(kind, ref) {
  try { await fetch(`${process.env.SUPABASE_URL}/rest/v1/agent_events?id=eq.${encodeURIComponent(kind + ':' + ref)}`, { method: 'DELETE', headers: svc() }); } catch (e) { console.error('forget-failed', kind, e.message); }
}
// A fingerprint of everything the review looks at: a mentor is only re-reviewed after they change their profile,
// so the AI can't give the same profile a different verdict on a later run.
function profilePrint(p) {
  const keys = ['name', 'headline', 'profession', 'experience', 'yearsExperience', 'bio', 'languages', 'education', 'certifications', 'linkedin', 'company', 'idealMentee', 'sessionRate'];
  return require('crypto').createHash('sha1').update(JSON.stringify(keys.map(k => p[k] == null ? null : p[k]))).digest('hex').slice(0, 16);
}
async function rememberVerdict(id, print, verdict) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/agent_events?on_conflict=id`, {
      method: 'POST', headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=minimal' }, svc()),
      body: JSON.stringify({ id: `verdict:${id}:${print}`, kind: 'verdict', ref: verdict, createdAt: new Date().toISOString() })
    });
  } catch (e) { console.error('verdict-save-failed', id, e.message); }
}
async function checkMemory() {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/agent_events?select=id&limit=1`, { headers: svc() });
  memoryOk = r.ok;
  return r.ok;
}

const PHOTO_TIP = 'We also recommend adding a profile photo. A friendly, professional photo helps clients feel confident choosing you.';


// ---------- run report ----------
function newReport() { return { done: [], needs: [], emails: 0, errors: [] }; }
async function mail(rep, to, subject, title, paras, cta) {
  if (!to) return false;
  if (rep.emails >= MAX_EMAILS_PER_RUN) return false;
  rep.emails++;
  const r = await M.sendMail(to, subject, M.layout(title, paras, cta));
  const ok = !!(r && (r.ok || r.skipped));
  if (!ok) { console.error('mail-failed', subject, to); rep.errors.push(`An email could not be sent (“${subject}”); it will be retried on the next run.`); }
  return ok;
}

// ---------- AI helpers ----------
// Reviews applications in small batches (big batches cut the AI's answer short or time out).
// Returns { map: {id: verdict}, error: why some could not be reviewed, or '' }.
const ASSESS_BATCH = 4;
async function assessApplications(apps) {
  if (!apps.length) return { map: {}, error: '' };
  if (!process.env.ANTHROPIC_API_KEY) { console.error('assess-skipped: ANTHROPIC_API_KEY is not set'); return { map: {}, error: 'the AI key (ANTHROPIC_API_KEY) is not set in Vercel' }; }
  const map = {}, problems = [];
  for (let i = 0; i < apps.length && i < 20; i += ASSESS_BATCH) {
    const input = apps.slice(i, i + ASSESS_BATCH).map(p => ({
      id: p.id, name: p.name, headline: p.headline, profession: p.profession, yearsExperience: p.experience || p.yearsExperience,
      bio: String(p.bio || '').slice(0, 1200), languages: p.languages, education: p.education,
      certifications: p.certifications, linkedin: p.linkedin, company: p.company, bestFor: p.idealMentee, sessionRate: p.sessionRate
    }));
    try {
      const out = await AI.askJSON(
        `You help the admin of Workar, a career mentorship marketplace, review mentor applications.
For each application judge: is the profile complete and specific, is the experience plausible and relevant to mentoring,
are there red flags (empty or copy-paste bio, inconsistent claims, unprofessional content, contact details or payment requests in the bio, missing LinkedIn).
Never ask the applicant to fill in "bestFor" (Best For), their mentoring approach, or other optional extras: "bestFor" is written automatically from their bio.
Use "approve" only when you would be comfortable showing this mentor to paying clients today.
Use "decline" ONLY for spam, abusive, offensive or clearly fake profiles. Every other profile that is not ready is "ask".
Return an array with one entry per application, using the exact "id" given: [{"id": "...", "verdict": "approve" | "ask" | "decline", "summary": one sentence,
"concerns": up to 3 short strings (empty array if none),
"askThem": if verdict is "ask", one or two polite sentences that tell the applicant exactly what to add or change on their profile to be listed
(for example: "Please add a short bio describing your experience and how you help people, and make sure your headline matches your current workplace."); otherwise ""}]`,
        JSON.stringify(input), { maxTokens: 400 * input.length + 300, timeoutMs: 45000 });
      // The model sometimes answers with one object, or wraps the list ({"applications": [...]}); accept those too.
      let list = Array.isArray(out) ? out : (out && (out.applications || out.results || out.reviews)) || (out && out.verdict ? [out] : []);
      if (!Array.isArray(list)) list = [];
      const ids = new Set(input.map(x => x.id));
      list.forEach((a, k) => {
        if (!a || !a.verdict) return;
        const id = ids.has(a.id) ? a.id : (input.length === list.length ? input[k].id : null); // fall back to the order of the input
        if (id) map[id] = Object.assign({}, a, { id });
      });
      const lost = input.filter(x => !map[x.id]).map(x => x.id);
      if (lost.length) { console.error('assess-incomplete', JSON.stringify({ lost, got: JSON.stringify(out).slice(0, 400) })); problems.push('the AI answer did not include every applicant'); }
    } catch (e) { console.error('assess-failed', e.message); problems.push('the AI review failed (' + String(e.message || e).slice(0, 120) + ')'); }
  }
  if (apps.length > 20) problems.push('more than 20 applications were waiting; the rest are reviewed on the next run');
  return { map, error: [...new Set(problems)].join('; ') };
}

async function checkReviews(reviews) {
  if (!reviews.length || !process.env.ANTHROPIC_API_KEY) return {};
  try {
    const out = await AI.askJSON(
      `You check new reviews on Workar, a mentorship marketplace. Flag a review only if it looks fake, spammy, abusive,
contains personal contact details, mentions payment outside the platform, or its text clearly contradicts its star rating.
Honest negative reviews are NOT a reason to flag.
Return an array: [{"id": "...", "flag": true|false, "reason": "short reason, empty if not flagged"}]`,
      JSON.stringify(reviews.map(r => ({ id: r.id, rating: r.rating, text: String(r.text || '').slice(0, 800) }))), { maxTokens: 800, timeoutMs: 20000 });
    const map = {}; (out || []).forEach(a => { if (a && a.id) map[a.id] = a; }); return map;
  } catch (e) { console.error('review-check-failed', e.message); return {}; }
}

// A profile is only auto-approved when the basics are really there, whatever the AI says.
// Extra limits on what the AI may approve by itself; anything below them gets a polite question instead:
//   at least AUTO_APPROVE_MIN_YEARS years of experience (default 1, admin's decision Oct 27 2026), a current workplace,
//   and no more than AUTO_APPROVE_DAILY_MAX approvals per day (default 3).
const MIN_YEARS = () => Number(process.env.AUTO_APPROVE_MIN_YEARS || 1);
const DAILY_MAX = () => Number(process.env.AUTO_APPROVE_DAILY_MAX || 3);
// Mentors must link a personal LinkedIn profile (linkedin.com/in/<name>); company pages or other links don't count.
function linkedInSlug(v) {
  let t = String(v || '').trim(); if (!t) return '';
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t.replace(/^\/+/, '');
  const m = /^https?:\/\/(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/in\/([^\/?#\s]{3,100})\/?(?:[?#].*)?$/i.exec(t);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch (e) { return m[1].toLowerCase(); }
}
function profileComplete(p) {
  return !!(p.name && (p.headline || p.profession) && String(p.bio || '').trim().length >= 80 && linkedInSlug(p.linkedin));
}
function meetsAutoLimits(p) {
  const years = parseFloat(String(p.experience || p.yearsExperience || '').replace(/[^0-9.]/g, '')) || 0;
  return years >= MIN_YEARS() && String(p.company || '').trim().length > 0;
}

// ---------- 1. mentor applications ----------
// Fully hands-off: the AI decides every application. Nothing waits for the admin; she only sees it in the digest.
//   approve  → profile live + welcome email (within the quality bar and the daily cap; over the cap waits for tomorrow's run)
//   ask      → one polite question (missing details, under the quality bar, or unclear); re-reviewed automatically when they update
//   decline  → no email to the applicant; the profile simply stays hidden
// Applicants who never answer a question are sent a closing note after 7 days.
const ASK_WAIT_DAYS = 7;
function missingBasics(p, others = []) {
  const miss = [];
  if (!(p.headline || p.profession)) miss.push('your current role or headline');
  if (String(p.bio || '').trim().length < 80) miss.push('a short bio (a few sentences about your experience and how you help people)');
  const slug = linkedInSlug(p.linkedin);
  if (!slug) miss.push('your LinkedIn profile link, so clients can learn more about your background');
  else if (others.some(o => o.id !== p.id && o.role === 'mentor' && linkedInSlug(o.linkedin) === slug)) miss.push('your own LinkedIn profile link (the one on your profile is already used by another Workar mentor)');
  const years = parseFloat(String(p.experience || p.yearsExperience || '').replace(/[^0-9.]/g, '')) || 0;
  if (years < MIN_YEARS()) miss.push(`your years of professional experience (Workar mentors have at least ${MIN_YEARS()})`);
  if (!String(p.company || '').trim()) miss.push('where you currently work');
  const langs = Array.isArray(p.languages) ? p.languages.filter(x => String(x || '').trim()) : String(p.languages || '').split(',').filter(x => x.trim());
  if (!langs.length) miss.push('the languages you can mentor in');
  return miss;
}
async function askedLongAgo(id) {
  try { const r = await M.rowsStrict(`agent_events?id=eq.${encodeURIComponent('ask:' + id)}&select=createdAt`); const t = r && r[0] && Date.parse(r[0].createdAt); return !!t && Date.now() - t > ASK_WAIT_DAYS * DAY; } catch (e) { return false; }
}
async function approvedToday() {
  const since = new Date(Date.now() - DAY).toISOString();
  try { const r = await M.rowsStrict(`agent_events?kind=eq.approve&createdAt=gte.${encodeURIComponent(since)}&select=id`); return Array.isArray(r) ? r.filter(x => x && String(x.id || '').startsWith('approve:')).length : 0; } catch (e) { return DAILY_MAX(); } // unknown: assume today's limit is reached
}
// "Best For" is never asked of applicants: when it is empty, the AI writes one short sentence from the bio (admin's decision, Oct 27 2026).
function clip(s, n) { if (s.length <= n) return s; const c = s.slice(0, n - 1); const i = c.lastIndexOf(' '); return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[\s,;:(\-]+$/, '') + '…'; }

async function fillBestFor(apps) {
  const need = apps.filter(p => !String(p.idealMentee || '').trim() && String(p.bio || '').trim().length >= 80);
  if (!need.length || !process.env.ANTHROPIC_API_KEY) return;
  try {
    const out = await AI.askJSON(
      `For each mentor on Workar, a career mentorship marketplace, write the "Best for" line shown on their profile:
one short sentence (max 140 characters) saying which people this mentor is best placed to help, based only on their bio, role and field.
Write it in the same language as the bio. No quotes, no names, no promises of specific services.
Return an array: [{"id": "...", "bestFor": "..."}]`,
      JSON.stringify(need.slice(0, 20).map(p => ({ id: p.id, role: p.headline || p.profession || '', field: p.field || '', bio: String(p.bio || '').slice(0, 1200) }))),
      { maxTokens: 120 * need.length + 200, timeoutMs: 30000 });
    const list = Array.isArray(out) ? out : (out && (out.mentors || out.results)) || [];
    for (const a of list) {
      const p = need.find(x => a && x.id === a.id), line = clip(String((a && a.bestFor) || '').trim(), 160);
      if (!p || !line) continue;
      const r = await M.patch(`profiles?id=eq.${encodeURIComponent(p.id)}`, { idealMentee: line });
      if (r.ok) p.idealMentee = line;
    }
  } catch (e) { console.error('best-for-failed', e.message); }
}
async function mentorApplications(rep, ctx, onlyId) {
  const filter = onlyId ? `&id=eq.${encodeURIComponent(onlyId)}` : '';
  const apps = (await M.rowsStrict(`profiles?role=eq.mentor&approved=eq.false${filter}&select=*`)).filter(p => !p.banned);
  await fillBestFor(apps);
  ctx.apps = apps;
  ctx.results = ctx.results || {};
  if (ctx.approvedNow == null) ctx.approvedNow = await approvedToday();
  if (!apps.length) return;
  // every mentor's LinkedIn, so one profile can't be used by two applicants
  let others = apps;
  try { const all = await M.rowsStrict(`profiles?role=eq.mentor&select=id,role,linkedin`); if (Array.isArray(all)) others = all.concat(apps.filter(a => !all.some(x => x.id === a.id))); } catch (e) { console.error('mentor-linkedin-list', e.message); }
  // Verdicts already given to this exact version of a profile are reused; only new or changed profiles go to the AI.
  const prints = {}; apps.forEach(p => { prints[p.id] = profilePrint(p); });
  const known = {};
  const wanted = apps.map(p => `verdict:${p.id}:${prints[p.id]}`);
  const past = wanted.length ? await M.rowsStrict(`agent_events?id=in.(${wanted.map(w => encodeURIComponent('"' + w + '"')).join(',')})&select=id,ref`) : [];
  past.forEach(e => { known[e.id] = e.ref; });
  const verdictOf = ref => String(ref || '').split('|')[0], questionOf = ref => String(ref || '').split('|').slice(1).join('|');
  const fresh = apps.filter(p => !known[`verdict:${p.id}:${prints[p.id]}`]);
  const { map: assess, error: assessError } = await assessApplications(fresh);
  const site = M.SITE();
  for (const p of apps) {
    const miss = missingBasics(p, others);
    const prior = known[`verdict:${p.id}:${prints[p.id]}`];
    // Missing basics (like LinkedIn) are known without the AI, so the applicant is still asked even when the AI review is unavailable.
    const a = prior ? { verdict: verdictOf(prior), summary: '', concerns: [], askThem: questionOf(prior) }
      : (assess[p.id] || (miss.length ? { verdict: 'ask', summary: '', concerns: [], askThem: '' } : null));
    if (!a) { ctx.results[p.id] = { verdict: 'pending' }; rep.errors.push(`The AI review of ${p.name || 'a mentor applicant'} could not run: ${assessError || 'no answer from the AI'}. It is retried automatically within the hour.`); continue; }
    let verdict = a.verdict === 'approve' || a.verdict === 'decline' ? a.verdict : 'ask';
    // Missing basics (LinkedIn, bio, workplace…) are always a question, never an approval or a decline.
    if (miss.length) verdict = 'ask';
    // Store the AI's own verdict (not the forced 'ask'), so it still applies once the missing basics are fixed.
    if (!prior && assess[p.id]) await rememberVerdict(p.id, prints[p.id], a.verdict === 'approve' || a.verdict === 'decline' ? a.verdict : 'ask|' + String(a.askThem || '').slice(0, 400));
    ctx.results[p.id] = { verdict, summary: a.summary || '', concerns: a.concerns || [], question: miss.length ? `Please add ${miss.join(', ')}.` : (a.askThem || '') };
    if (verdict === 'approve' && !on('AUTO_APPROVE_MENTORS')) { rep.needs.push({ kind: 'app', text: `<b>${M.esc(p.name)}</b> looks ready to approve (automatic approval is switched off). ${M.esc(a.summary || '')}` }); continue; }
    if (verdict === 'approve' && (ctx.approvedNow || 0) >= DAILY_MAX()) { ctx.results[p.id].verdict = 'waiting'; rep.done.push(`<b>${M.esc(p.name)}</b> is ready; today's limit of ${DAILY_MAX()} approvals was reached, so tomorrow's run approves them.`); continue; }
    if (verdict === 'approve') {
      if (!(await once('approve', p.id))) continue;
      const r = await M.patch(`profiles?id=eq.${encodeURIComponent(p.id)}`, { approved: true });
      if (!r.ok) { await forget('approve', p.id); ctx.results[p.id].verdict = 'error'; rep.errors.push(`Could not approve ${p.name}; it will be retried on the next run`); continue; }
      await mail(rep, await M.emailOf(p.id), 'Your Workar mentor profile is live', `Welcome aboard, ${p.name}`,
        ['Thank you for joining Workar. Your mentor profile has been reviewed and is now visible to people looking for guidance.',
          'Please make sure your weekly availability is up to date so clients can book you.', p.avatarUrl ? '' : PHOTO_TIP], { text: 'Open my profile', url: site + '/?go=dashboard' });
      ctx.approvedNow = (ctx.approvedNow || 0) + 1;
      (ctx.approvedIds = ctx.approvedIds || []).push(p.id);
      rep.done.push(`Approved and welcomed mentor <b>${M.esc(p.name)}</b> (${M.esc(p.profession || '')}). ${M.esc(a.summary || '')}`);
    } else if (verdict === 'decline') {
      // No "not at this time" email is ever sent to the applicant (admin's decision, Oct 2026): the profile simply stays hidden.
      if (await once('decline', p.id)) {
        rep.done.push(`Did not approve mentor applicant <b>${M.esc(p.name || '')}</b>; the profile stays hidden and no email was sent to them. ${M.esc(a.summary || '')}${a.concerns && a.concerns.length ? ' (' + M.esc(a.concerns.join('; ')) + ')' : ''}`);
      }
    } else {
      const q = miss.length ? `Please add ${miss.join('; ')}` : (a.askThem || 'Please add a short bio (a few sentences about your experience and how you help people).');
      const firstAsk = await once('ask', p.id);
      if (firstAsk) await once('ask', p.id + ':' + prints[p.id]);
      if (firstAsk) {
        const askParas = [`Hi ${M.esc(first(p.name))},`,
          'Welcome to Workar, and thank you for joining us as a mentor.',
          miss.length === 1 ? `Your profile is almost ready to go live. To publish it, please add ${M.esc(miss[0])}.` : miss.length ? 'Your profile is almost ready to go live. To publish it, please add:' : `Your profile is almost ready to go live. ${M.esc(q)}`,
          miss.length > 1 ? M.list(miss) : '',
          p.avatarUrl ? '' : PHOTO_TIP,
          'As soon as you save your changes, we will review your profile and let you know when it is live.',
          'We are glad to have you with us.<br>The Workar team'];
        const to = await M.emailOf(p.id);
        if (!(await mail(rep, to, 'Your Workar mentor profile is almost ready', 'One last step', askParas, { text: 'Complete my profile', url: site + '/?go=dashboard' }))) { await forget('ask', p.id); await forget('ask', p.id + ':' + prints[p.id]); continue; }
        // The team inbox gets a hidden copy of this email automatically (see sendMail in _mail.js).
        rep.done.push(`Asked mentor applicant <b>${M.esc(p.name)}</b>: “${M.esc(q)}”`);
      } else if (await once('ask', p.id + ':' + prints[p.id])) {
        // They updated the profile after our first request, and it still needs something: tell them exactly what, once per version.
        if (!(await mail(rep, await M.emailOf(p.id), 'Thank you for updating your Workar profile', 'Nearly there',
          [`Hi ${M.esc(first(p.name))},`,
            'Thank you for updating your mentor profile. We have reviewed it again.',
            miss.length === 1 ? `To publish it, please add ${M.esc(miss[0])}.` : miss.length ? 'To publish it, please add:' : M.esc(q),
            miss.length > 1 ? M.list(miss) : '',
            'As soon as you save your changes, we will review it again and let you know when it is live.',
            'Kind regards,<br>The Workar team'], { text: 'Complete my profile', url: site + '/?go=dashboard' }))) { await forget('ask', p.id + ':' + prints[p.id]); continue; }
        rep.done.push(`Asked mentor applicant <b>${M.esc(p.name)}</b> again after their update: “${M.esc(q)}”`);
      } else if (await askedLongAgo(p.id) && await once('ask_close', p.id)) {
        // One friendly reminder a week after the first request, then nothing more.
        await mail(rep, await M.emailOf(p.id), 'A reminder about your Workar mentor profile', 'Your profile is almost ready',
          [`Hi ${M.esc(first(p.name))},`,
            miss.length === 1 ? `A quick reminder: your mentor profile will go live as soon as you add ${M.esc(miss[0])}.` : 'A quick reminder: your mentor profile will go live as soon as a few missing details are added.',
            'Once you save your profile, we will review it right away and let you know when it is live.',
            'Kind regards,<br>The Workar team'], { text: 'Complete my profile', url: site + '/?go=dashboard' });
        rep.done.push(`Sent a closing reminder to mentor applicant <b>${M.esc(p.name)}</b>.`);
      }
    }
  }
}

// ---------- 2 + 3 + 4. bookings ----------
async function bookings(rep, ctx) {
  const now = Date.now(), site = M.SITE();
  const all = await M.rowsStrict(`requests?select=*`);
  ctx.requests = all;
  const ids = [...new Set(all.flatMap(r => [r.mentorId, r.clientId]).filter(Boolean))];
  const names = {};
  if (ids.length) (await M.rowsStrict(`profiles?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,name,timezone`)).forEach(p => { names[p.id] = p; });
  ctx.names = names;
  const nm = id => (names[id] && names[id].name) || 'Someone';

  for (const r of all) {
    const age = now - ms(r.createdAt);
    const start = r.startsAt ? Date.parse(r.startsAt) : 0;
    const timePassed = start && start < now;

    // 2. mentor has not answered
    if (r.status === 'pending') {
      if (timePassed || age > 3 * DAY) {
        if (!(await once('expire', r.id))) continue;
        await M.patch(`requests?id=eq.${encodeURIComponent(r.id)}`, { status: 'cancelled' });
        await mail(rep, await M.emailOf(r.clientId), 'Your session request has been closed', `Let's find you another time, ${first(nm(r.clientId))}`,
          [`${M.esc(nm(r.mentorId))} wasn't able to respond to your request in time, so we have closed it. You have not been charged.`,
            'Other mentors may be available sooner. The AI match on the Find a mentor page can suggest the best fit for your goal.'], { text: 'Find another mentor', url: site + '/?go=browse' });
        await mail(rep, await M.emailOf(r.mentorId), 'A session request expired', 'A request expired',
          [`The request from ${M.esc(nm(r.clientId))} was closed because it wasn't answered within 3 days.`, 'To avoid missing future requests, please keep your weekly availability up to date.'], { text: 'Open my profile', url: site + '/?go=dashboard' });
        rep.done.push(`Closed an unanswered request from ${M.esc(nm(r.clientId))} to ${M.esc(nm(r.mentorId))} and pointed the client to other mentors.`);
      } else if (age > DAY && await once('nudge-mentor', r.id)) {
        await mail(rep, await M.emailOf(r.mentorId), `Reminder: ${nm(r.clientId)} is waiting for your reply`, 'A client is waiting for you',
          [`${M.esc(nm(r.clientId))} requested a session with you${r.startsAt ? ' on <b>' + M.esc(M.when(r, names[r.mentorId] && names[r.mentorId].timezone)) + '</b>' : ''}.`,
            'Please accept it, or message them on Workar to agree on another time. Requests that are not answered within 3 days close automatically.'], { text: 'Review the request', url: site + '/?go=dashboard' });
        rep.done.push(`Reminded ${M.esc(nm(r.mentorId))} to answer ${M.esc(nm(r.clientId))}'s request.`);
      }
      continue;
    }

    // 3. accepted but not paid
    if (r.status === 'accepted' && Number(r.amountCents) > 0 && !r.paid) {
      const soon = start && start - now < 6 * HOUR;
      if (timePassed || soon || age > 3 * DAY) {
        if (!(await once('release', r.id))) continue;
        await M.patch(`requests?id=eq.${encodeURIComponent(r.id)}`, { status: 'cancelled' });
        await mail(rep, await M.emailOf(r.clientId), 'Your unpaid booking was released', 'Your booking was released',
          [`Your session with ${M.esc(nm(r.mentorId))} was not paid in time, so the time slot has been released. You have not been charged.`, 'You are welcome to book again whenever it suits you.'], { text: 'Book again', url: site + '/?go=browse' });
        await mail(rep, await M.emailOf(r.mentorId), 'A booking was released', 'A booking was released',
          [`${M.esc(nm(r.clientId))} did not complete payment, so the session has been cancelled and your time is free again.`], { text: 'Open Workar', url: site + '/?go=dashboard' });
        rep.done.push(`Released an unpaid booking between ${M.esc(nm(r.clientId))} and ${M.esc(nm(r.mentorId))}.`);
      } else if (age > DAY && await once('nudge-pay', r.id)) {
        await mail(rep, await M.emailOf(r.clientId), `Complete your booking with ${nm(r.mentorId)}`, 'Your mentor is ready for you',
          [`${M.esc(nm(r.mentorId))} accepted your session${r.startsAt ? ' on <b>' + M.esc(M.when(r, names[r.clientId] && names[r.clientId].timezone)) + '</b>' : ''}.`,
            'Please complete the payment to confirm it. The call link and calendar invite are sent right after. Unpaid bookings are released after 3 days.'], { text: 'Pay and confirm', url: site + '/?go=dashboard' });
        rep.done.push(`Reminded ${M.esc(nm(r.clientId))} to pay for the session ${M.esc(nm(r.mentorId))} accepted.`);
      }
      continue;
    }

    // 4. paid session in the past, not marked done
    const active = r.status === 'accepted' && (!(Number(r.amountCents) > 0) || r.paid);
    if (active && timePassed && now - start > 12 * HOUR && !(Number(r.sessionsDone) > 0)) {
      if (await once('mark-done', r.id)) {
        await mail(rep, await M.emailOf(r.mentorId), `Please mark your session with ${nm(r.clientId)} as done`, 'How did the session go?',
          [`Your session with ${M.esc(nm(r.clientId))} was planned for ${M.esc(M.when(r, names[r.mentorId] && names[r.mentorId].timezone))}.`,
            'If it took place, please mark it as done on Workar. This is what releases your payout. You can also send your client a short action plan from the same page.'], { text: 'Mark as done', url: site + '/?go=dashboard' });
        await mail(rep, await M.emailOf(r.clientId), `Did your session with ${nm(r.mentorId)} take place?`, 'We hope your session went well',
          [`Your session with ${M.esc(nm(r.mentorId))} was planned for ${M.esc(M.when(r, names[r.clientId] && names[r.clientId].timezone))}.`,
            'If anything went wrong, for example the mentor did not join, simply reply to this email and we will make it right.'], null);
        rep.done.push(`Asked ${M.esc(nm(r.mentorId))} to mark the session with ${M.esc(nm(r.clientId))} as done, and checked in with the client.`);
      } else if (now - start > 4 * DAY) {
        rep.needs.push({ kind: 'session', text: `Paid session between ${M.esc(nm(r.mentorId))} and ${M.esc(nm(r.clientId))} (${M.esc(M.when(r))}) is still not marked done after 4 days. Check whether it happened before paying out.` });
      }
    }
  }
}

// ---------- 5. reviews ----------
async function reviews(rep, ctx) {
  const now = Date.now(), site = M.SITE();
  const all = await M.rowsStrict(`reviews?select=*&order=createdAt.desc&limit=200`);
  const names = ctx.names || {};
  const nm = id => (names[id] && names[id].name) || 'Someone';
  ctx.newReviews = all.filter(r => now - ms(r.createdAt) < DAY);

  // ask for a review once a session is done
  const reviewed = new Set(all.map(r => r.mentorId + '|' + r.clientId));
  for (const r of (ctx.requests || [])) {
    if (!(r.paid && Number(r.sessionsDone) > 0)) continue;
    if (reviewed.has(r.mentorId + '|' + r.clientId)) continue;
    if (!(await once('ask-review', r.id))) continue;
    await mail(rep, await M.emailOf(r.clientId), `How was your session with ${nm(r.mentorId)}?`, `Thank you, ${first(nm(r.clientId))}`,
      [`We hope your session with ${M.esc(nm(r.mentorId))} was useful.`, 'A short review helps other people choose the right mentor, and helps your mentor grow. It takes less than a minute.'], { text: 'Write a review', url: site + '/?go=dashboard' });
    rep.done.push(`Invited ${M.esc(nm(r.clientId))} to review ${M.esc(nm(r.mentorId))}.`);
  }

  // moderation of new reviews
  if (!ctx.newReviews.length) return;
  const flags = await checkReviews(ctx.newReviews);
  const realSession = new Set((ctx.requests || []).filter(q => q.paid).map(q => q.mentorId + '|' + q.clientId));
  for (const r of ctx.newReviews) {
    const f = flags[r.id];
    const noSession = !realSession.has(r.mentorId + '|' + r.clientId);
    if (!(f && f.flag) && !noSession) continue;
    const reason = f && f.flag ? f.reason : 'no paid session between them';
    if (on('AUTO_HIDE_REVIEWS') && await once('hide-review', r.id)) {
      const pr = await M.patch(`reviews?id=eq.${encodeURIComponent(r.id)}`, { hidden: true });
      if (pr.ok) { rep.done.push(`Hid a ${r.rating}-star review of ${M.esc(nm(r.mentorId))}: ${M.esc(reason)}.`); rep.needs.push({ kind: 'review', text: `Hidden review of ${M.esc(nm(r.mentorId))} by ${M.esc(nm(r.clientId))}: “${M.esc(String(r.text || '').slice(0, 160))}”. If it is fine, set hidden to false in Supabase (table reviews).` }); continue; }
    }
    rep.needs.push({ kind: 'review', text: `Suspicious review of ${M.esc(nm(r.mentorId))} by ${M.esc(nm(r.clientId))}: ${M.esc(reason)}.` });
  }
}

// ---------- 6. new sign-ups ----------
async function signups(rep, ctx) {
  const now = Date.now(), site = M.SITE();
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: svc() });
  if (!r.ok) throw new Error(`could not read the sign-up list (${r.status}); today's sign-up and mentor counts are unknown`);
  const data = await r.json();
  const users = (data && data.users) || [];
  ctx.users = users;
  const profiles = {};
  (await M.rowsStrict(`profiles?select=id,name,role,approved,banned`)).forEach(p => { profiles[p.id] = p; });
  ctx.profiles = profiles;
  const booked = new Set((ctx.requests || []).map(q => q.clientId));
  for (const u of users) {
    const age = now - Date.parse(u.created_at);
    if (!u.email || !u.email_confirmed_at || age < 2 * DAY || age > 14 * DAY) continue;
    const p = profiles[u.id];
    if (!p) {
      if (!(await once('finish-profile', u.id))) continue;
      await mail(rep, u.email, 'Finish setting up your Workar profile', 'You are one step away',
        ['Thank you for creating a Workar account. Your profile is not finished yet.', 'It takes about two minutes, and lets us suggest mentors who have faced the same challenge as you, or lets clients find you if you would like to mentor.'],
        { text: 'Finish my profile', url: site + '/?go=dashboard' });
      rep.done.push(`Reminded a new sign-up (${M.esc(u.email)}) to finish their profile.`);
    } else if (p.role !== 'mentor' && !booked.has(u.id) && age > 3 * DAY) {
      if (!(await once('first-booking', u.id))) continue;
      await mail(rep, u.email, 'Not sure which mentor to choose?', `We can help you choose, ${first(p.name)}`,
        ['Describe your situation in a sentence or two on the Find a mentor page, and Workar suggests the mentors best placed to help.', 'If you do not see your field yet, reply to this email and we will look for the right mentor for you.'],
        { text: 'Get mentor suggestions', url: site + '/?go=browse' });
      rep.done.push(`Helped ${M.esc(p.name || u.email)} choose a first mentor.`);
    }
  }
}

// ---------- daily digest (always sent) ----------
async function digest(rep, ctx, extra) {
  const adminEmail = M.CONTACT_EMAIL();
  const tz = process.env.DIGEST_TZ || 'America/Vancouver';
  const now = Date.now(), site = M.SITE();
  const reqs = ctx.requests || [];
  const names = ctx.names || {};
  const nm = id => (names[id] && names[id].name) || 'Someone';
  const users = ctx.users || [];
  const newUsers = users.filter(u => now - Date.parse(u.created_at) < DAY).length;
  const newReqs = reqs.filter(r => now - ms(r.createdAt) < DAY).length;
  // Applications still waiting after this run, and mentors whose profiles are live (banned accounts excluded).
  const approvedIds = ctx.approvedIds || [];
  const results = ctx.results || {};
  const waiting = (ctx.apps || []).filter(p => !approvedIds.includes(p.id) && !(results[p.id] && results[p.id].verdict === 'decline')).length;
  const mentorsLive = Object.values(ctx.profiles || {}).filter(p => p.role === 'mentor' && !p.banned && (p.approved !== false || approvedIds.includes(p.id))).length;
  const today = reqs.filter(r => r.status === 'accepted' && (r.paid || !(Number(r.amountCents) > 0)) && r.startsAt && Date.parse(r.startsAt) > now && Date.parse(r.startsAt) - now < DAY)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  // Mentor payouts are automatic (api/_payouts.js); only held or failed ones reach this digest, via the cron's problem list.
  const tickets = await M.rows(`support_tickets?status=eq.open&select=id,email,name,summary,urgent,createdAt&order=createdAt.asc&limit=20`);

  const h3 = t => `<h3 style="margin:18px 0 8px;font-size:16px;color:#4A3526;">${t}</h3>`;
  const paras = [];
  paras.push(h3('Last 24 hours'));
  paras.push(M.list([
    ctx.users ? `${newUsers} new sign-up${newUsers === 1 ? '' : 's'}` : 'New sign-ups: unknown (see Needs you)',
    `${newReqs} new booking request${newReqs === 1 ? '' : 's'}`,
    ctx.profiles ? `${Math.max(0, mentorsLive)} mentor${mentorsLive === 1 ? '' : 's'} live, ${waiting} application${waiting === 1 ? '' : 's'} waiting` : `Mentors live: unknown, ${waiting} application${waiting === 1 ? '' : 's'} waiting`,
    `${today.length} session${today.length === 1 ? '' : 's'} in the next 24 hours`
  ]));
  if (today.length) {
    paras.push(h3('Coming up'));
    paras.push(M.list(today.slice(0, 10).map(r => `${M.when(r, tz)}: ${nm(r.mentorId)} with ${nm(r.clientId)}`)));
  }

  const needs = rep.needs.slice();
  tickets.forEach(t => needs.unshift({ kind: 'ticket', text: `${t.urgent ? '<b>Urgent</b> ' : ''}Support request from ${M.esc(t.name || t.email)}: ${M.esc(String(t.summary || '').slice(0, 180))} (reply to the email you received when it arrived)` }));
  if (memoryOk === false) needs.unshift({ kind: 'setup', text: '<b>Setup needed:</b> the agent_events table is missing, so the automatic emails are paused (to avoid sending anything twice). Run the SQL in AUTOPILOT-SETUP.txt once in Supabase.' });
  rep.errors.forEach(e => needs.push({ kind: 'error', text: M.esc(e) }));
  (extra || []).forEach(e => needs.push({ kind: 'error', text: M.esc(e) }));

  paras.push(h3(needs.length ? `Needs you (${needs.length})` : 'Needs you'));
  paras.push(needs.length ? `<ul style="margin:0;padding-left:20px;">${needs.map(n => `<li style="margin:0 0 8px;">${n.text}</li>`).join('')}</ul>` : 'Nothing today. Everything was handled.');

  paras.push(h3(`Done for you automatically (${rep.done.length})`));
  paras.push(rep.done.length ? `<ul style="margin:0;padding-left:20px;">${rep.done.slice(0, 40).map(d => `<li style="margin:0 0 6px;">${d}</li>`).join('')}</ul>` : 'No actions were needed.');
  if (rep.done.length > 40) paras.push(`And ${rep.done.length - 40} more.`);

  const dateTxt = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
  const subject = needs.length ? `Workar today: ${needs.length} thing${needs.length === 1 ? '' : 's'} need you, ${rep.done.length} handled` : `Workar today: all handled (${rep.done.length} action${rep.done.length === 1 ? '' : 's'})`;
  const sent = await M.sendMail(adminEmail, subject, M.layout(`Your Workar day, ${dateTxt}`, paras, { text: 'Open the admin panel', url: site + '/?go=admin' }), null, { noCopy: true });
  const ok = !!(sent && (sent.ok || sent.skipped));
  if (!ok) console.error('digest-send-failed', JSON.stringify(sent || {}).slice(0, 300));
  return { digest: ok ? 'sent' : 'failed', needs: needs.length, done: rep.done.length };
}

// Review one applicant right away (called when a mentor submits or updates a pending profile).
// The admin only hears about it when something needs attention; approvals show up in the daily digest.
async function reviewOne(id) {
  const rep = newReport(), ctx = {};
  await checkMemory();
  await mentorApplications(rep, ctx, id);
  return Object.assign({ errors: rep.errors }, (ctx.results || {})[id] || { verdict: 'none' });
}

// ---------- entry point ----------
async function run(extraErrors) {
  const rep = newReport(), ctx = {};
  await checkMemory();
  const steps = [['applications', mentorApplications], ['bookings', bookings], ['reviews', reviews], ['signups', signups]];
  for (const [name, fn] of steps) {
    try { await fn(rep, ctx); } catch (e) { console.error('autopilot-' + name, e); rep.errors.push(`The ${name} agent had a problem: ${e.message || e}`); }
  }
  const out = await digest(rep, ctx, extraErrors);
  return Object.assign({ emails: rep.emails }, out);
}

module.exports = { _assess: (a) => assessApplications(a), run, reviewOne, profileComplete, once, missingBasics, mentorApplications, linkedInSlug };
