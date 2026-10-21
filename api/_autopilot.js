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
  if (!r.ok) { memoryOk = false; console.error('agent_events-missing', r.status, await r.text()); return false; }
  memoryOk = true;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0; // empty = already done before
}
async function checkMemory() {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/agent_events?select=id&limit=1`, { headers: svc() });
  memoryOk = r.ok;
  return r.ok;
}

// ---------- run report ----------
function newReport() { return { done: [], needs: [], emails: 0, errors: [] }; }
async function mail(rep, to, subject, title, paras, cta) {
  if (!to) return false;
  if (rep.emails >= MAX_EMAILS_PER_RUN) return false;
  rep.emails++;
  const r = await M.sendMail(to, subject, M.layout(title, paras, cta));
  return !!(r && (r.ok || r.skipped));
}

// ---------- AI helpers ----------
async function assessApplications(apps) {
  if (!apps.length || !process.env.ANTHROPIC_API_KEY) return {};
  const input = apps.slice(0, 10).map(p => ({
    id: p.id, name: p.name, headline: p.headline, profession: p.profession, yearsExperience: p.experience || p.yearsExperience,
    bio: String(p.bio || '').slice(0, 1200), languages: p.languages, education: p.education,
    certifications: p.certifications, linkedin: p.linkedin, company: p.company, bestFor: p.idealMentee, sessionRate: p.sessionRate
  }));
  try {
    const out = await AI.askJSON(
      `You help the admin of Workar, a career mentorship marketplace, review mentor applications.
For each application judge: is the profile complete and specific, is the experience plausible and relevant to mentoring,
are there red flags (empty or copy-paste bio, inconsistent claims, unprofessional content, contact details or payment requests in the bio, missing LinkedIn).
Use "approve" only when you would be comfortable showing this mentor to paying clients today.
Return an array: [{"id": "...", "verdict": "approve" | "ask" | "decline", "summary": one sentence,
"concerns": up to 3 short strings (empty array if none), "askThem": one polite question to send if verdict is "ask", else ""}]`,
      JSON.stringify(input), { maxTokens: 1500, timeoutMs: 25000 });
    const map = {}; (out || []).forEach(a => { if (a && a.id) map[a.id] = a; }); return map;
  } catch (e) { console.error('assess-failed', e.message); return {}; }
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
//   at least AUTO_APPROVE_MIN_YEARS years of experience (default 3), a current workplace,
//   and no more than AUTO_APPROVE_DAILY_MAX approvals per day (default 3).
const MIN_YEARS = () => Number(process.env.AUTO_APPROVE_MIN_YEARS || 3);
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
//   decline  → one polite "not at this time" email; the profile stays hidden
// Applicants who never answer a question are sent a closing note after 7 days.
const ASK_WAIT_DAYS = 7;
function missingBasics(p, others = []) {
  const miss = [];
  if (!(p.headline || p.profession)) miss.push('your current role or headline');
  if (String(p.bio || '').trim().length < 80) miss.push('a short bio (a few sentences about your experience and how you help people)');
  const slug = linkedInSlug(p.linkedin);
  if (!slug) miss.push('a link to your personal LinkedIn profile (for example linkedin.com/in/yourname); it is required for every Workar mentor');
  else if (others.some(o => o.id !== p.id && o.role === 'mentor' && linkedInSlug(o.linkedin) === slug)) miss.push('your own LinkedIn profile link (the one on your profile is already used by another Workar mentor)');
  const years = parseFloat(String(p.experience || p.yearsExperience || '').replace(/[^0-9.]/g, '')) || 0;
  if (years < MIN_YEARS()) miss.push(`your years of professional experience (Workar mentors have at least ${MIN_YEARS()})`);
  if (!String(p.company || '').trim()) miss.push('where you currently work');
  return miss;
}
async function approvedToday() {
  const since = new Date(Date.now() - DAY).toISOString();
  try { const r = await M.rows(`agent_events?kind=eq.approve&createdAt=gte.${encodeURIComponent(since)}&select=id`); return Array.isArray(r) ? r.filter(x => x && String(x.id || '').startsWith('approve:')).length : 0; } catch (e) { return 0; }
}
async function mentorApplications(rep, ctx, onlyId) {
  const filter = onlyId ? `&id=eq.${encodeURIComponent(onlyId)}` : '';
  const apps = (await M.rows(`profiles?role=eq.mentor&approved=eq.false${filter}&select=*`)).filter(p => !p.banned);
  ctx.apps = apps;
  ctx.results = ctx.results || {};
  if (ctx.approvedNow == null) ctx.approvedNow = await approvedToday();
  if (!apps.length) return;
  // every mentor's LinkedIn, so one profile can't be used by two applicants
  let others = apps;
  try { const all = await M.rows(`profiles?role=eq.mentor&select=id,role,linkedin`); if (Array.isArray(all)) others = all.concat(apps.filter(a => !all.some(x => x.id === a.id))); } catch (e) { console.error('mentor-linkedin-list', e.message); }
  const assess = await assessApplications(apps);
  const site = M.SITE();
  for (const p of apps) {
    const a = assess[p.id];
    if (!a) { ctx.results[p.id] = { verdict: 'pending' }; rep.done.push(`AI review of <b>${M.esc(p.name || 'a mentor applicant')}</b> was not available today; it will try again tomorrow.`); continue; }
    const miss = missingBasics(p, others);
    let verdict = a.verdict === 'approve' || a.verdict === 'decline' ? a.verdict : 'ask';
    if (verdict === 'approve' && miss.length) verdict = 'ask';
    ctx.results[p.id] = { verdict, summary: a.summary || '', concerns: a.concerns || [], question: miss.length ? `Please add ${miss.join(', ')}.` : (a.askThem || '') };
    if (verdict === 'approve' && !on('AUTO_APPROVE_MENTORS')) { rep.needs.push({ kind: 'app', text: `<b>${M.esc(p.name)}</b> looks ready to approve (automatic approval is switched off). ${M.esc(a.summary || '')}` }); continue; }
    if (verdict === 'approve' && (ctx.approvedNow || 0) >= DAILY_MAX()) { ctx.results[p.id].verdict = 'waiting'; rep.done.push(`<b>${M.esc(p.name)}</b> is ready; today's limit of ${DAILY_MAX()} approvals was reached, so tomorrow's run approves them.`); continue; }
    if (verdict === 'approve') {
      if (!(await once('approve', p.id))) continue;
      const r = await M.patch(`profiles?id=eq.${encodeURIComponent(p.id)}`, { approved: true });
      if (!r.ok) { ctx.results[p.id].verdict = 'error'; rep.errors.push(`Could not approve ${p.name}`); continue; }
      await mail(rep, await M.emailOf(p.id), 'Your Workar mentor profile is live', `Welcome aboard, ${p.name}`,
        ['Thank you for joining Workar. Your mentor profile has been reviewed and is now visible to people looking for guidance.',
          'Please make sure your weekly availability is up to date so clients can book you.'], { text: 'Open my profile', url: site + '/?go=dashboard' });
      ctx.approvedNow = (ctx.approvedNow || 0) + 1;
      rep.done.push(`Approved and welcomed mentor <b>${M.esc(p.name)}</b> (${M.esc(p.profession || '')}). ${M.esc(a.summary || '')}`);
    } else if (verdict === 'decline') {
      if (await once('decline', p.id)) {
        await mail(rep, await M.emailOf(p.id), 'About your Workar mentor application', `Thank you for applying, ${first(p.name)}`,
          ['Thank you for your interest in mentoring on Workar. After reviewing your profile, we are not able to list it at this time.',
            'You are very welcome to update your profile with more detail about your experience, and we will review it again automatically.'], { text: 'Update my profile', url: site + '/?go=dashboard' });
        rep.done.push(`Declined mentor applicant <b>${M.esc(p.name || '')}</b>. ${M.esc(a.summary || '')}${a.concerns && a.concerns.length ? ' (' + M.esc(a.concerns.join('; ')) + ')' : ''}`);
      }
    } else {
      const q = miss.length ? `To finish your profile, please add ${miss.join(', ')}.` : (a.askThem || 'Could you add a little more detail about your experience and how you help people?');
      if (await once('ask', p.id)) {
        const askParas = ['We are reviewing your mentor profile and have one request before it goes live:', `<b>${M.esc(q)}</b>`,
            'Please update your profile on Workar. As soon as you save it, we review it again automatically.'];
        const to = await M.emailOf(p.id);
        await mail(rep, to, 'A quick question about your Workar mentor profile', `Thank you for applying, ${first(p.name)}`, askParas, { text: 'Update my profile', url: site + '/?go=dashboard' });
        // The admin gets a copy of exactly what was sent, so she knows without having to do anything.
        await mail(rep, (process.env.ADMIN_EMAIL || 'naeimeh.alaghehband@gmail.com'), `Copy: we asked ${p.name} to complete their mentor profile`, `Sent to ${M.esc(p.name)}${to ? ' (' + M.esc(to) + ')' : ''}`,
          ['This is a copy of the email Workar sent. Nothing is needed from you; the profile goes live by itself once it is complete.', '<hr style="border:0;border-top:1px solid #EAE0D2;margin:16px 0">', `<b>Thank you for applying, ${M.esc(first(p.name))}</b>`].concat(askParas));
        rep.done.push(`Asked mentor applicant <b>${M.esc(p.name)}</b>: “${M.esc(q)}”`);
      } else if (ms(p.createdAt) && Date.now() - ms(p.createdAt) > ASK_WAIT_DAYS * DAY && await once('ask_close', p.id)) {
        await mail(rep, await M.emailOf(p.id), 'Your Workar mentor profile is still waiting', `Hello ${first(p.name)}`,
          ['Your mentor profile is not live yet because a few details are still missing. Whenever you are ready, update your profile and we will review it again automatically.'], { text: 'Update my profile', url: site + '/?go=dashboard' });
        rep.done.push(`Sent a closing reminder to mentor applicant <b>${M.esc(p.name)}</b>.`);
      }
    }
  }
}

// ---------- 2 + 3 + 4. bookings ----------
async function bookings(rep, ctx) {
  const now = Date.now(), site = M.SITE();
  const all = await M.rows(`requests?select=*`);
  ctx.requests = all;
  const ids = [...new Set(all.flatMap(r => [r.mentorId, r.clientId]).filter(Boolean))];
  const names = {};
  if (ids.length) (await M.rows(`profiles?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,name,timezone`)).forEach(p => { names[p.id] = p; });
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
  const all = await M.rows(`reviews?select=*&order=createdAt.desc&limit=200`);
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
  if (!r.ok) return;
  const data = await r.json();
  const users = (data && data.users) || [];
  ctx.users = users;
  const profiles = {};
  (await M.rows(`profiles?select=id,name,role`)).forEach(p => { profiles[p.id] = p; });
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
  const waiting = Math.max(0, (ctx.apps || []).length - (ctx.approvedNow || 0));
  const mentorsLive = Object.values(ctx.profiles || {}).filter(p => p.role === 'mentor').length - waiting;
  const today = reqs.filter(r => r.status === 'accepted' && (r.paid || !(Number(r.amountCents) > 0)) && r.startsAt && Date.parse(r.startsAt) > now && Date.parse(r.startsAt) - now < DAY)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  // Mentor payouts are automatic (api/_payouts.js); only held or failed ones reach this digest, via the cron's problem list.
  const tickets = await M.rows(`support_tickets?status=eq.open&select=id,email,name,summary,urgent,createdAt&order=createdAt.asc&limit=20`);

  const h3 = t => `<h3 style="margin:18px 0 8px;font-size:16px;color:#4A3526;">${t}</h3>`;
  const paras = [];
  paras.push(h3('Last 24 hours'));
  paras.push(M.list([
    `${newUsers} new sign-up${newUsers === 1 ? '' : 's'}`,
    `${newReqs} new booking request${newReqs === 1 ? '' : 's'}`,
    `${Math.max(0, mentorsLive)} mentor${mentorsLive === 1 ? '' : 's'} live, ${waiting} application${waiting === 1 ? '' : 's'} waiting`,
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
  await M.sendMail(adminEmail, subject, M.layout(`Your Workar day, ${dateTxt}`, paras, { text: 'Open the admin panel', url: site + '/?go=admin' }));
  return { digest: 'sent', needs: needs.length, done: rep.done.length };
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

module.exports = { run, reviewOne, profileComplete, once, missingBasics, mentorApplications, linkedInSlug };
