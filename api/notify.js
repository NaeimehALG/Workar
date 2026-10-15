process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Serverless Function: sends Workar email notifications.
// The browser only says WHAT happened (event + request id); who gets the email and what it says
// is decided here, from the database, so nobody can use this to send arbitrary emails.
const M = require('./_mail');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { event, requestId, targetId } = body || {};
  try {
    const me = await M.userFromToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!me) { res.status(401).json({ error: 'sign in required' }); return; }
    const site = M.SITE();
    const adminEmail = (process.env.ADMIN_EMAIL || 'naeimeh.alaghehband@gmail.com').toLowerCase();

    // ---- mentor applications ----
    if (event === 'mentor_applied') {
      const p = await M.profile(me.id);
      if (p.role !== 'mentor') { res.status(403).end(); return; }
      await M.sendMail(M.CONTACT_EMAIL(), `New mentor application: ${p.name}`,
        M.layout('A new mentor wants to join Workar', [`<b>${M.esc(p.name)}</b> (${M.esc(me.email)}) just created a mentor profile. It stays hidden until you approve it.`], { text: 'Review applications', url: site + '/?go=admin' }));
      res.status(200).json({ ok: true }); return;
    }
    if (event === 'mentor_approved') {
      if ((me.email || '').toLowerCase() !== adminEmail || !targetId) { res.status(403).end(); return; }
      const p = await M.profile(targetId);
      await M.sendMail(await M.emailOf(targetId), 'Your Workar mentor profile is live',
        M.layout(`Welcome aboard, ${p.name}`, ['Your mentor profile has been approved and is now visible to people looking for guidance.', 'Make sure your weekly availability is up to date so clients can book you.'], { text: 'Open my profile', url: site + '/?go=dashboard' }));
      res.status(200).json({ ok: true }); return;
    }

    // ---- booking events ----
    const r = (await M.rows(`requests?id=eq.${encodeURIComponent(requestId || '')}&select=*`))[0];
    if (!r) { res.status(404).json({ error: 'no request' }); return; }
    // Admin approved a decision on a reported problem: tell both sides the outcome.
    if (event === 'dispute_resolved') {
      if ((me.email || '').toLowerCase() !== adminEmail || !r.problemResolvedAt) { res.status(403).end(); return; }
      const refunded = r.status === 'refunded';
      const [toM, toC] = await Promise.all([M.emailOf(r.mentorId), M.emailOf(r.clientId)]);
      const mName = (await M.profile(r.mentorId)).name, cName = (await M.profile(r.clientId)).name;
      const fn = n => String(n || '').trim().split(/\s+/)[0] || 'there';
      if (toC) await M.sendMail(toC, `The outcome of your session review`,
        M.layout('Your report has been reviewed', [
          `Dear ${M.esc(fn(cName))},`,
          `Thank you for your patience while we reviewed your session with <b>${M.esc(mName)}</b> on <b>${M.esc(M.when(r))}</b>.`,
          refunded ? 'We have carefully considered what both of you told us, and we have decided not to charge you for this session. The hold on your card has been released, and no payment will be taken.'
                   : 'We have carefully considered what both of you told us, together with the call record, which shows that the session took place. The session fee will therefore be charged as booked. We understand this may not be the outcome you hoped for, and we truly appreciate you raising it with us.',
          'If you have any questions or would like to share anything further, please simply reply to this email.',
          'Thank you for being part of Workar.<br>Kind regards,<br>The Workar team'
        ], { text: 'Open Workar', url: site + '/?go=messages' }));
      if (toM) await M.sendMail(toM, `The outcome of the review of your session with ${cName}`,
        M.layout('The session review is complete', [
          `Dear ${M.esc(fn(mName))},`,
          `Thank you for your patience and for your help while we reviewed your session with <b>${M.esc(cName)}</b> on <b>${M.esc(M.when(r))}</b>.`,
          refunded ? 'After carefully considering what both of you told us and the call record, we have decided that the client will not be charged for this session. As a result, no payout is due for it. We know this can be disappointing, and we are grateful for your understanding.'
                   : 'After carefully considering what both of you told us and the call record, we have released the payment for this session. Your share will be paid out as usual.',
          'If you have any questions, please simply reply to this email.',
          'Thank you for mentoring on Workar.<br>Kind regards,<br>The Workar team'
        ], { text: 'Open Workar', url: site + '/?go=dashboard' }));
      res.status(200).json({ ok: true }); return;
    }
    const isMentor = r.mentorId === me.id, isClient = r.clientId === me.id;
    if (!isMentor && !isClient) { res.status(403).end(); return; }
    const toId = isMentor ? r.clientId : r.mentorId;
    const [from, to] = await Promise.all([M.profile(me.id), M.profile(toId)]);
    const toEmail = await M.emailOf(toId);
    const whenTxt = M.when(r, to.timezone);
    const fromName = M.esc(from.name || 'Someone');
    const dash = { text: 'Open Workar', url: site + '/?go=dashboard' };
    let subject, title, paras, attachments = [];

    if (event === 'problem_reported') {
      if (!isClient || !r.problemReportedAt) { res.status(403).end(); return; }
      // The dispute agent asks both sides, reads the call attendance and briefs the admin (api/_dispute.js).
      let opened = false;
      try { const o = await require('./_dispute').open(r); opened = !!(o.ok || o.skipped); } catch (e) { console.error('dispute-open-failed', r.id, e.message); }
      if (!opened) {
        await M.sendMail(M.CONTACT_EMAIL ? M.CONTACT_EMAIL() : adminEmail, `Problem reported: ${from.name} → ${to.name}`,
          M.layout('A client reported a problem with a session', [
            `<b>${fromName}</b> reported a problem with the session with <b>${M.esc(to.name || '')}</b> on ${M.esc(whenTxt)} (${r.amountCents ? '$' + (r.amountCents / 100).toFixed(2) + ' CAD' : 'free'}).`,
            r.problemNote ? `Their note: “${M.esc(String(r.problemNote).slice(0, 800))}”` : '',
            'The payment to the mentor is on hold until you decide. In the admin Payouts table you can release it, or refund the client in Stripe.'
          ], { text: 'Open admin', url: site + '/?go=admin' }), [], { replyTo: me.email || undefined });
      }
      res.status(200).json({ ok: true }); return;
    }
    switch (event) {
      case 'request_new':
        if (!isClient) break;
        subject = `New session request from ${from.name}`;
        title = `${from.name} would like to book a session`;
        paras = [`Requested time: <b>${M.esc(whenTxt)}</b>`, r.message ? `Their note: “${M.esc(String(r.message).slice(0, 400))}”` : '', 'Accept it to confirm the time, or message them on Workar to agree on another one.'];
        dash.text = 'Review the request'; break;
      case 'request_accepted':
        if (!isMentor) break;
        subject = `${from.name} accepted your session`;
        title = 'Your session was accepted';
        paras = [`<b>${fromName}</b> confirmed your session on <b>${M.esc(whenTxt)}</b>.`, r.amountCents > 0 && !r.paid ? 'Complete the payment to lock it in. The call link unlocks right after.' : 'At the session time, open Workar and press Join video call.'];
        dash.text = r.amountCents > 0 && !r.paid ? 'Pay and confirm' : 'Open Workar'; break;
      case 'request_declined':
        if (!isMentor) break;
        subject = `Update on your session request`;
        title = 'Your request was declined';
        paras = [`<b>${fromName}</b> couldn't take the session on ${M.esc(whenTxt)}.`, 'You can book another time or choose a different mentor.'];
        dash.text = 'Find another time'; break;
      case 'request_cancelled':
        if (r.paid && r.startsAt) {
          const MT = require('./_meeting');
          attachments = MT.icsAttachment(MT.buildIcs({ r, title: `Workar session with ${from.name}`, description: 'This session was cancelled.', cancelled: true }));
        }
        subject = `Session cancelled by ${from.name}`;
        title = 'A session was cancelled';
        paras = [`<b>${fromName}</b> cancelled the session planned for ${M.esc(whenTxt)}.`, r.paid ? 'If you paid, see our refund policy for what happens next.' : ''];
        break;
      case 'time_changed':
        if (r.paid) {
          // paid session: both people get the new time, the call link and an updated calendar invite
          await require('./_session').sendConfirmation(r, { updated: true });
          res.status(200).json({ ok: true }); return;
        }
        subject = `New time proposed by ${from.name}`;
        title = 'Your session time changed';
        paras = [`<b>${fromName}</b> changed your session to <b>${M.esc(whenTxt)}</b>.`, 'If that doesn’t work, reply to them in your Workar messages.'];
        break;
      case 'times_proposed': {
        if (!isMentor || !Array.isArray(r.proposedTimes) || !r.proposedTimes.length) break;
        const tz = to.timezone || r.tz;
        subject = `${from.name} suggested new times for your session`;
        title = 'Pick a time that suits you';
        paras = [`<b>${fromName}</b> can't make ${M.esc(whenTxt)} work and suggested these times instead:`,
          M.list(r.proposedTimes.map(t => M.when({ startsAt: t }, tz))),
          'Choose one on Workar and your session is accepted straight away.'];
        dash.text = 'Choose a time'; dash.url = site + '/?go=requests'; break;
      }
      case 'time_picked':
        if (!isClient || r.status !== 'accepted') break;
        subject = `${from.name} picked a time`;
        title = 'Your session is accepted';
        paras = [`<b>${fromName}</b> chose <b>${M.esc(M.when(r, to.timezone))}</b> from the times you suggested.`, r.amountCents > 0 && !r.paid ? 'They have been asked to pay to confirm. You will get the call link as soon as they do.' : 'The session is confirmed.'];
        dash.url = site + '/?go=requests'; break;
      case 'message': {
        // only the newest message from the sender; no email if they already wrote in the last 10 minutes
        const ms = await M.rows(`messages?requestId=eq.${encodeURIComponent(r.id)}&senderId=eq.${encodeURIComponent(me.id)}&select=text,createdAt&order=createdAt.desc&limit=2`);
        if (!ms.length) break;
        if (ms[1] && (new Date(ms[0].createdAt) - new Date(ms[1].createdAt)) < 10 * 60 * 1000) { res.status(200).json({ skipped: 'recent' }); return; }
        subject = `New message from ${from.name}`;
        title = `${from.name} sent you a message`;
        paras = [`“${M.esc(String(ms[0].text).replace(/\[\[wk:[^\]]*\]\]/g, '').trim().slice(0, 500))}”`];
        dash.text = 'Reply on Workar'; break;
      }
    }
    if (!subject) { res.status(400).json({ error: 'unknown event' }); return; }
    await M.sendMail(toEmail, subject, M.layout(title, paras, dash), attachments);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
};
