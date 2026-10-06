// Vercel Cron (see vercel.json): runs once a day.
//  1. Session reminders for the next ~30 hours, with the call link, an AI prep brief for the mentor
//     and AI prep tips for the client.
//  2. Re-engagement: one friendly nudge to book again, 7-30 days after a finished booking.
//  3. Autopilot (api/_autopilot.js): handles applications, stuck bookings, reviews and sign-ups by itself,
//     then emails the admin a daily digest of what it did and what still needs her.
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
      paras.push(`Your call link: ${M.link(url, url)}. We recommend testing your camera and microphone a few minutes before you join.`);
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

const ms = v => (v == null ? 0 : (typeof v === 'number' ? v : (isNaN(Number(v)) ? Date.parse(v) : Number(v)))) || 0;
const DAY = 24 * 3600 * 1000;

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
          system: `Write 2 short, courteous sentences to a client of Workar, a career mentorship site, about a week or more after their mentoring session. Mention their goal if known and suggest one concrete next step a follow-up session with the same mentor could help with. No pressure, no discounts, no invented facts. Plain text, English.`,
          messages: [{ role: 'user', content: JSON.stringify({ clientFirstName: String(client.name || '').split(' ')[0], goal: (r.prepBrief && r.prepBrief.goal) || client.profession || '', mentorName: mentor.name, mentorProfession: mentor.profession }) }],
          maxTokens: 200, timeoutMs: 12000
        });
        line = AI.textOf(data);
      } catch (e) { console.error('nudge-ai-failed', e.message); }
    }
    if (!line) line = `It's been a little while since your session with ${mentor.name}. A follow-up session is a good way to check progress and plan your next step.`;
    await M.sendMail(await M.emailOf(r.clientId), `Ready for your next step with ${mentor.name}?`,
      M.layout('We hope your session was helpful', [M.esc(line), `<span style="font-size:13px;color:#8a7461;">You'll only get this note once per booking.</span>`], { text: `Book ${mentor.name} again`, url: M.SITE() + '/?go=browse' }));
    sent++;
  }
  return { nudged: sent };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) { res.status(401).end(); return; }
  const out = {}, problems = [];
  try { Object.assign(out, await sessionReminders()); } catch (e) { console.error('reminders-failed', e); problems.push('Session reminders failed: ' + (e.message || e)); }
  try { Object.assign(out, await reengage()); } catch (e) { console.error('reengage-failed', e); problems.push('Re-engagement emails failed: ' + (e.message || e)); }
  // Autopilot agents + the daily digest to the admin (always sent, even on a quiet day)
  try { Object.assign(out, await require('./_autopilot').run(problems)); } catch (e) { console.error('autopilot-failed', e); out.autopilotError = String(e.message || e); }
  res.status(200).json(out);
};
