process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Cron (see vercel.json): runs once a day.
//  1. Session reminders for the next ~30 hours, with the call link, an AI prep brief for the mentor
//     and AI prep tips for the client.
//  2. Re-engagement: one friendly nudge to book again, 7-30 days after a finished booking.
//  3. Card holds (api/_holds.js): hold saved cards before sessions, charge after sessions happen,
//     release holds for sessions that didn't happen.
//  4. Mentor payouts: sends each mentor their share 2 days after the session (api/_payouts.js).
//  5. LinkedIn (api/_linkedin.js): sends the week's queued posts to Typefully for the Workar page.
//  6. Autopilot (api/_autopilot.js): handles applications, stuck bookings, reviews and sign-ups by itself,
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
    // Fixed, human-written text: no AI guesses about what was discussed in the session.
    const who = M.esc(mentor.name || 'your mentor'), hi = M.esc(String(client.name || '').trim().split(/\s+/)[0] || 'there');
    let reviewed = false;
    try { const rv = await M.rows(`reviews?mentorId=eq.${encodeURIComponent(r.mentorId)}&clientId=eq.${encodeURIComponent(r.clientId)}&select=id&limit=1`); reviewed = Array.isArray(rv) && rv.length > 0; } catch (e) { console.error('nudge-review-check', e.message); }
    await M.sendMail(await M.emailOf(r.clientId), `How was your session with ${mentor.name || 'your mentor'}?`,
      M.layout(`Your next step with ${who}`, [
        `Hi ${hi},`,
        `Thank you for your session with ${who}. We hope it gave you useful direction toward your goals.`,
        reviewed ? '' : `<b>Share your experience:</b> a short review helps ${who} and helps other clients choose the right mentor. <a href="${M.SITE()}/?go=dashboard" style="color:#8B6A4C;font-weight:700;">Leave a review</a>`,
        `<b>Keep the momentum going:</b> if you would like to continue, you can book a follow-up session with ${who} directly from their profile.`,
        'Kind regards,<br>The Workar team'
      ], { text: `Book ${mentor.name || 'your mentor'} again`, url: M.SITE() + '/?go=mentor&m=' + encodeURIComponent(r.mentorId) }));
    sent++;
  }
  return { nudged: sent };
}

// ---------- Mentor payouts (Stripe Connect) ----------
const P = require('./_payouts');
const usd = c => '$' + (Number(c || 0) / 100).toFixed(2);
async function payoutMail(kind, r, cents) {
  const client = await M.profile(r.clientId);
  const to = await M.emailOf(r.mentorId);
  if (!to) return;
  if (kind === 'paid') {
    await M.sendMail(to, `You've been paid ${usd(cents)} for your Workar session`,
      M.layout('Your payout is on its way', [
        `Your share for the session with <b>${M.esc(client.name)}</b> (<b>${usd(cents)}</b>) has been sent to your bank account.`,
        `It usually arrives within a few business days. You can see every payout in your Workar earnings.`
      ], { text: 'See your earnings', url: M.SITE() + '/?go=dashboard' }));
  } else {
    await M.sendMail(to, `You have ${usd(cents)} waiting on Workar`,
      M.layout('Add your bank details to get paid', [
        `Your share for the session with <b>${M.esc(client.name)}</b> (<b>${usd(cents)}</b>) is ready to be paid.`,
        `Add your bank details once, through Stripe, our payment partner. It takes about 5 minutes, and after that every payout is sent to you automatically.`
      ], { text: 'Add my bank details', url: M.SITE() + '/?go=dashboard' }));
  }
}

// ---------- Card holds ----------
async function holdMail(kind, r) {
  if (kind !== 'card-failed') return;
  const [mentor, client] = await Promise.all([M.profile(r.mentorId), M.profile(r.clientId)]);
  const whenTxt = M.when(r, client.timezone);
  const toClient = await M.emailOf(r.clientId);
  if (toClient) await M.sendMail(toClient, `Action needed: confirm your card for your session with ${mentor.name}`,
    M.layout('We couldn\'t hold your card', [
      `Your session with <b>${M.esc(mentor.name)}</b> on <b>${M.esc(whenTxt)}</b> is coming up, but your bank didn't accept the hold on your card.`,
      `Please confirm a card again so your session stays booked. You're still only charged after the session takes place.`
    ], { text: 'Confirm my card', url: M.SITE() + '/?go=messages' }));
  const toMentor = await M.emailOf(r.mentorId);
  if (toMentor) await M.sendMail(toMentor, `${client.name}'s card needs updating`,
    M.layout('Payment not secured yet', [
      `The hold on <b>${M.esc(client.name)}</b>'s card for your session on <b>${M.esc(M.when(r, mentor.timezone))}</b> didn't go through. We've asked them to confirm a card again.`,
      `The call link unlocks again as soon as they do. You don't need to do anything.`
    ], { text: 'Open Workar', url: M.SITE() + '/?go=messages' }));
}

module.exports = async (req, res) => {
  // Public health check for uptime monitors: GET /api/reminders?health=1 → 200 "ok" when the database answers
  if (req.query && req.query.health) {
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/site_settings?select=*&limit=1`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY } });
      res.status(r.ok ? 200 : 503).send(r.ok ? 'ok' : 'database-down');
    } catch (e) { res.status(503).send('database-down'); }
    return;
  }
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) { res.status(401).end(); return; }
  const out = {}, problems = [];
  // Vercel stops this job at 300s. Optional steps are skipped when time runs short, so the mentor review
  // and the daily report (which come last) always run, and the report says what was skipped.
  const t0 = Date.now(), late = () => Date.now() - t0 > 170 * 1000;
  const skip = what => problems.push(`${what} was skipped today because the daily job ran short of time; it runs again tomorrow.`);
  try { Object.assign(out, await sessionReminders()); } catch (e) { console.error('reminders-failed', e); problems.push('Session reminders failed: ' + (e.message || e)); }
  try { Object.assign(out, await reengage()); } catch (e) { console.error('reengage-failed', e); problems.push('Re-engagement emails failed: ' + (e.message || e)); }
  // Backup for the Stripe webhook: confirm any paid booking that wasn't marked paid yet
  try {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await fetch(`${url}/rest/v1/requests?status=eq.accepted&paid=is.false&stripeSessionId=not.is.null&select=id`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    const rows = r.ok ? await r.json() : [];
    let n = 0; for (const x of rows) { try { if ((await P.confirmPayment(x.id)).paid) n++; } catch (e) { console.error('confirm-sweep', x.id, e.message); } }
    out.paymentsConfirmed = n;
  } catch (e) { problems.push('Payment check failed: ' + (e.message || e)); }
  try {
    const h = await require('./_holds').runHolds({ mail: holdMail });
    out.cardsHeld = h.held; out.cardsCharged = h.charged; out.holdsReleased = h.released; out.holdsRefunded = h.refunded; out.holdsReplaced = h.reheld; out.cardsFailed = h.cardFailed;
    problems.push(...h.problems);
  } catch (e) { console.error('holds-failed', e); problems.push('Card holds failed: ' + (e.message || e)); }
  try {
    const p = await P.releaseDue({ sendMail: payoutMail });
    out.payoutsSent = p.paidOut; out.payoutsSentCents = p.paidOutCents; out.payoutsWaitingForBank = p.waitingForBank.length;
    problems.push(...p.problems);
  } catch (e) { console.error('payouts-failed', e); problems.push('Mentor payouts failed: ' + (e.message || e)); }
  // Dispute agent: brief the admin on reported problems before the card hold runs out
  if (late()) skip('The dispute review'); else try { Object.assign(out, await require('./_dispute').runDue(problems)); } catch (e) { console.error('disputes-failed', e); problems.push('Dispute agent failed: ' + (e.message || e)); }
  // LinkedIn: send this week's queued posts to Typefully (api/_linkedin.js)
  if (late()) skip('LinkedIn posting'); else try { Object.assign(out, await require('./_linkedin').run(problems)); } catch (e) { console.error('linkedin-failed', e); problems.push('LinkedIn posting failed: ' + (e.message || e)); }
  // Weekly off-site backup emailed to the admin (Sundays, api/_backup.js)
  if (late()) skip('The weekly backup'); else try { Object.assign(out, await require('./_backup').run(problems)); } catch (e) { console.error('backup-failed', e); problems.push('Weekly backup failed: ' + (e.message || e)); }
  // Autopilot agents + the daily digest to the admin (always sent, even on a quiet day)
  try { Object.assign(out, await require('./_autopilot').run(problems)); } catch (e) { console.error('autopilot-failed', e); out.autopilotError = String(e.message || e); }
  res.status(200).json(out);
};
