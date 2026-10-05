// Vercel Cron (see vercel.json): runs once a day.
//  1. Session reminders for the next ~30 hours, with the call link, an AI prep brief for the mentor
//     and AI prep tips for the client.
//  2. Re-engagement: one friendly nudge to book again, 7-30 days after a finished booking.
//  3. Admin digest for Workar's admin: mentor applications with an AI assessment, review checks,
//     stuck bookings and payouts due. The AI only recommends; approvals and refunds stay with the admin.
// Protected with CRON_SECRET (Vercel sends it automatically when the env variable is set).
const M = require('./_mail');
const MT = require('./_meeting');
const S = require('./_session');
const AI = require('./_ai');

const MAX_AI_BRIEFS = 10; // keeps the daily run inside the time limit; extra sessions get a plain reminder

async function sessionReminders() {
  const now = new Date(), soon = new Date(Date.now() + 30 * 3600 * 1000);
  const list = await M.rows(`requests?status=eq.accepted&remindedAt=is.null&startsAt=gte.${now.toISOString()}&startsAt=lte.${soon.toISOString()}&select=*`);
  let sent = 0, briefs = 0;
  for (const r of list) {
    if (r.amountCents > 0 && !r.paid) continue;
    let brief = r.prepBrief || null;
    if (!brief && briefs < MAX_AI_BRIEFS && process.env.ANTHROPIC_API_KEY) {
      try { brief = await S.makePrepBrief(r); briefs++; } catch (e) { console.error('prep-brief-failed', r.id, e.message); }
    }
    const url = MT.meetingUrlFor(r);
    const [mentor, client] = await Promise.all([M.profile(r.mentorId), M.profile(r.clientId)]);
    for (const [who, other, isMentor] of [[mentor, client, true], [client, mentor, false]]) {
      const paras = [`You're meeting <b>${M.esc(other.name)}</b> on <b>${M.esc(M.when(r, who.timezone))}</b>.`];
      if (brief && isMentor) {
        paras.push(`<h3 style="margin:8px 0 6px;font-size:16px;color:#4A3526;">Prep brief</h3>`);
        if (brief.goal) paras.push(`<b>What they want:</b> ${M.esc(brief.goal)}`);
        if (brief.context && brief.context.length) paras.push(M.list(brief.context));
        if (brief.agenda && brief.agenda.length) { paras.push('<b>Suggested agenda</b>'); paras.push(M.list(brief.agenda)); }
        if (brief.firstQuestion) paras.push(`<b>A good first question:</b> “${M.esc(brief.firstQuestion)}”`);
        paras.push(`<span style="font-size:13px;color:#8a7461;">Written by Workar's AI from the client's profile and messages. Check it against what they tell you.</span>`);
      } else if (brief && !isMentor && brief.clientTips && brief.clientTips.length) {
        paras.push('<b>To get the most out of it:</b>');
        paras.push(M.list(brief.clientTips));
      }
      paras.push(`Your call link: ${M.link(url, url)}. Test your camera and microphone a few minutes before.`);
      await M.sendMail(await M.emailOf(who.id), `Reminder: your Workar session with ${other.name}`,
        M.layout('Your session is coming up', paras, { text: 'Join the call', url }));
    }
    const upd = { remindedAt: new Date().toISOString() };
    if (brief && !r.prepBrief) upd.prepBrief = brief;
    const pr = await M.patch(`requests?id=eq.${encodeURIComponent(r.id)}`, upd);
    if (!pr.ok && upd.prepBrief) await M.patch(`requests?id=eq.${encodeURIComponent(r.id)}`, { remindedAt: upd.remindedAt }); // prepBrief column missing
    sent++;
  }
  return { reminded: sent, briefs };
}

// ---------- Admin digest ----------
const ms = v => (v == null ? 0 : (typeof v === 'number' ? v : (isNaN(Number(v)) ? Date.parse(v) : Number(v)))) || 0;
const DAY = 24 * 3600 * 1000;

async function assessApplications(apps) {
  if (!apps.length || !process.env.ANTHROPIC_API_KEY) return {};
  const input = apps.slice(0, 10).map(p => ({
    id: p.id, name: p.name, headline: p.headline, profession: p.profession, yearsExperience: p.experience,
    bio: String(p.bio || '').slice(0, 1200), skills: p.skills, languages: p.languages, education: p.education,
    certifications: p.certifications, linkedin: p.linkedin, helpsWith: p.helpsWith, sessionRate: p.sessionRate
  }));
  try {
    const out = await AI.askJSON(
      `You help the admin of Workar, a career mentorship marketplace, review mentor applications.
For each application judge: is the profile complete and specific, is the experience plausible and relevant to mentoring,
are there red flags (empty or copy-paste bio, inconsistent claims, unprofessional content, contact details or payment requests in the bio, missing LinkedIn).
You only recommend. The admin decides. Be fair and concise.
Return an array: [{"id": "...", "verdict": "approve" | "ask" | "decline", "summary": one sentence,
"concerns": up to 3 short strings (empty array if none), "askThem": one question to send if verdict is "ask", else ""}]`,
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
Return an array: [{"id": "...", "flag": true|false, "reason": "short reason, empty if not flagged"}]`,
      JSON.stringify(reviews.map(r => ({ id: r.id, rating: r.rating, text: String(r.text || '').slice(0, 800) }))), { maxTokens: 800, timeoutMs: 20000 });
    const map = {}; (out || []).forEach(a => { if (a && a.id) map[a.id] = a; }); return map;
  } catch (e) { console.error('review-check-failed', e.message); return {}; }
}

async function adminDigest() {
  const adminEmail = process.env.ADMIN_EMAIL || 'naeimeh.alaghehband@gmail.com';
  const now = Date.now(), site = M.SITE();
  const [apps, reviews, pending, unpaid, paid] = await Promise.all([
    M.rows(`profiles?role=eq.mentor&approved=eq.false&select=*`),
    M.rows(`reviews?select=*&order=createdAt.desc&limit=40`),
    M.rows(`requests?status=eq.pending&select=id,mentorId,clientId,createdAt,startsAt`),
    M.rows(`requests?status=eq.accepted&paid=eq.false&amountCents=gt.0&select=id,mentorId,clientId,createdAt,startsAt`),
    M.rows(`requests?paid=eq.true&select=id,mentorId,clientId,startsAt,status,sessionsDone,payoutDone`)
  ]);
  const newReviews = reviews.filter(r => now - ms(r.createdAt) < DAY);
  const stuckPending = pending.filter(r => now - ms(r.createdAt) > 2 * DAY);
  const stuckUnpaid = unpaid.filter(r => now - ms(r.createdAt) > 2 * DAY);
  const notMarkedDone = paid.filter(r => r.status === 'accepted' && r.startsAt && now - Date.parse(r.startsAt) > DAY && !(Number(r.sessionsDone) > 0));
  const payoutsDue = paid.filter(r => !r.payoutDone && Number(r.sessionsDone) > 0);

  if (!apps.length && !newReviews.length && !stuckPending.length && !stuckUnpaid.length && !notMarkedDone.length && !payoutsDue.length) return { digest: 'nothing to report' };

  const [assess, revFlags] = await Promise.all([assessApplications(apps), checkReviews(newReviews)]);
  const ids = new Set([].concat(...[stuckPending, stuckUnpaid, notMarkedDone, newReviews].map(l => l.flatMap(r => [r.mentorId, r.clientId]))).filter(Boolean));
  const names = {};
  if (ids.size) (await M.rows(`profiles?id=in.(${[...ids].map(encodeURIComponent).join(',')})&select=id,name`)).forEach(p => { names[p.id] = p.name; });
  const nm = id => M.esc(names[id] || 'Unknown');
  const paras = [];
  const verdictLabel = { approve: 'Looks ready to approve', ask: 'Ask a question first', decline: 'Probably decline' };

  if (apps.length) {
    paras.push(`<h3 style="margin:8px 0 6px;font-size:16px;color:#4A3526;">Mentor applications (${apps.length})</h3>`);
    for (const p of apps.slice(0, 10)) {
      const a = assess[p.id];
      paras.push(`<b>${M.esc(p.name || 'No name')}</b>, ${M.esc(p.profession || 'no profession given')}` +
        (a ? `<br><b>AI suggestion:</b> ${M.esc(verdictLabel[a.verdict] || a.verdict)}. ${M.esc(a.summary || '')}` +
          (a.concerns && a.concerns.length ? `<br><b>Concerns:</b> ${M.esc(a.concerns.join('; '))}` : '') +
          (a.askThem ? `<br><b>You could ask:</b> “${M.esc(a.askThem)}”` : '') : ''));
    }
    if (apps.length > 10) paras.push(`And ${apps.length - 10} more in the admin panel.`);
  }
  if (newReviews.length) {
    const flagged = newReviews.filter(r => revFlags[r.id] && revFlags[r.id].flag);
    const realSession = new Set(paid.map(q => q.mentorId + '|' + q.clientId));
    const noSession = newReviews.filter(r => !realSession.has(r.mentorId + '|' + r.clientId));
    paras.push(`<h3 style="margin:8px 0 6px;font-size:16px;color:#4A3526;">New reviews (${newReviews.length})</h3>`);
    if (!flagged.length && !noSession.length) paras.push('Nothing looks off.');
    flagged.forEach(r => paras.push(`⚠️ ${r.rating}★ review of <b>${nm(r.mentorId)}</b> by ${nm(r.clientId)}: ${M.esc(revFlags[r.id].reason)}`));
    noSession.forEach(r => paras.push(`⚠️ ${nm(r.clientId)} reviewed <b>${nm(r.mentorId)}</b> without a paid session between them.`));
  }
  if (stuckPending.length || stuckUnpaid.length || notMarkedDone.length) {
    paras.push(`<h3 style="margin:8px 0 6px;font-size:16px;color:#4A3526;">Bookings that need a nudge</h3>`);
    const items = []
      .concat(stuckPending.map(r => `${names[r.mentorId] || 'A mentor'} hasn't answered ${names[r.clientId] || 'a client'}'s request for over 2 days.`))
      .concat(stuckUnpaid.map(r => `${names[r.clientId] || 'A client'} hasn't paid for the session ${names[r.mentorId] || 'the mentor'} accepted.`))
      .concat(notMarkedDone.map(r => `Paid session between ${names[r.mentorId] || 'a mentor'} and ${names[r.clientId] || 'a client'} is past but not marked done. Check whether it happened.`));
    paras.push(M.list(items.slice(0, 15)));
  }
  if (payoutsDue.length) paras.push(`<b>Payouts:</b> ${payoutsDue.length} completed paid booking${payoutsDue.length === 1 ? '' : 's'} not yet paid out to mentors.`);

  const subjectBits = [apps.length ? `${apps.length} application${apps.length === 1 ? '' : 's'}` : '', newReviews.length ? `${newReviews.length} new review${newReviews.length === 1 ? '' : 's'}` : '',
    (stuckPending.length + stuckUnpaid.length + notMarkedDone.length) ? `${stuckPending.length + stuckUnpaid.length + notMarkedDone.length} to follow up` : ''].filter(Boolean);
  await M.sendMail(adminEmail, `Workar daily digest: ${subjectBits.join(', ') || 'payouts due'}`,
    M.layout('Your Workar daily digest', paras.concat([`<span style="font-size:13px;color:#8a7461;">AI suggestions are a starting point. You make the final call.</span>`]), { text: 'Open the admin panel', url: site + '/?go=admin' }));
  return { digest: 'sent' };
}


// ---------- Re-engagement agent ----------
// 7-30 days after a client's last completed booking, if they haven't booked again,
// send one short, personal nudge to continue with the same mentor.
const PKG_SESSIONS = { single: 1, resume: 2, interview: 3, offer: 6 };
async function reengage() {
  const now = Date.now();
  const done = (await M.rows(`requests?paid=eq.true&nudgedAt=is.null&select=*`))
    .filter(r => r.startsAt && now - Date.parse(r.startsAt) > 7 * DAY && now - Date.parse(r.startsAt) < 30 * DAY)
    .filter(r => (Number(r.sessionsDone) || 0) >= (Number(r.sessions) || PKG_SESSIONS[r.packageKey] || 1));
  let sent = 0;
  for (const r of done.slice(0, 10)) {
    const later = await M.rows(`requests?clientId=eq.${encodeURIComponent(r.clientId)}&select=id,createdAt,status`);
    const bookedAgain = later.some(x => x.id !== r.id && ms(x.createdAt) > ms(r.createdAt) && x.status !== 'declined' && x.status !== 'cancelled');
    await M.patch(`requests?id=eq.${encodeURIComponent(r.id)}`, { nudgedAt: new Date().toISOString() });
    if (bookedAgain) continue;
    const [mentor, client] = await Promise.all([M.fullProfile(r.mentorId), M.fullProfile(r.clientId)]);
    let line = '';
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const data = await AI.callClaude({
          system: `Write 2 short, warm sentences to a client of Workar, a career mentorship site, about a week or more after their mentoring session. Mention their goal if known and suggest one concrete next step a follow-up session with the same mentor could help with. No pressure, no discounts, no invented facts. Plain text, English.`,
          messages: [{ role: 'user', content: JSON.stringify({ clientFirstName: String(client.name || '').split(' ')[0], goal: (r.prepBrief && r.prepBrief.goal) || client.profession || '', mentorName: mentor.name, mentorProfession: mentor.profession }) }],
          maxTokens: 200, timeoutMs: 12000
        });
        line = AI.textOf(data);
      } catch (e) { console.error('nudge-ai-failed', e.message); }
    }
    if (!line) line = `It's been a little while since your session with ${mentor.name}. A follow-up session is a good way to check progress and plan your next step.`;
    await M.sendMail(await M.emailOf(r.clientId), `Ready for your next step with ${mentor.name}?`,
      M.layout('How is it going?', [M.esc(line), `<span style="font-size:13px;color:#8a7461;">You'll only get this note once per booking.</span>`], { text: `Book ${mentor.name} again`, url: M.SITE() + '/?go=browse' }));
    sent++;
  }
  return { nudged: sent };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) { res.status(401).end(); return; }
  const out = {};
  try { Object.assign(out, await sessionReminders()); } catch (e) { console.error('reminders-failed', e); out.remindersError = String(e.message || e); }
  try { Object.assign(out, await reengage()); } catch (e) { console.error('reengage-failed', e); out.reengageError = String(e.message || e); }
  try { Object.assign(out, await adminDigest()); } catch (e) { console.error('digest-failed', e); out.digestError = String(e.message || e); }
  res.status(200).json(out);
};
