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
      await M.sendMail(adminEmail, `New mentor application: ${p.name}`,
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
    const isMentor = r.mentorId === me.id, isClient = r.clientId === me.id;
    if (!isMentor && !isClient) { res.status(403).end(); return; }
    const toId = isMentor ? r.clientId : r.mentorId;
    const [from, to] = await Promise.all([M.profile(me.id), M.profile(toId)]);
    const toEmail = await M.emailOf(toId);
    const whenTxt = M.when(r, to.timezone);
    const fromName = M.esc(from.name || 'Someone');
    const dash = { text: 'Open Workar', url: site + '/?go=dashboard' };
    let subject, title, paras;

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
        subject = `Session cancelled by ${from.name}`;
        title = 'A session was cancelled';
        paras = [`<b>${fromName}</b> cancelled the session planned for ${M.esc(whenTxt)}.`, r.paid ? 'If you paid, see our refund policy for what happens next.' : ''];
        break;
      case 'time_changed':
        subject = `New time proposed by ${from.name}`;
        title = 'Your session time changed';
        paras = [`<b>${fromName}</b> changed your session to <b>${M.esc(whenTxt)}</b>.`, 'If that doesn’t work, reply to them in your Workar messages.'];
        break;
      case 'message': {
        // only the newest message from the sender; no email if they already wrote in the last 10 minutes
        const ms = await M.rows(`messages?requestId=eq.${encodeURIComponent(r.id)}&senderId=eq.${encodeURIComponent(me.id)}&select=text,createdAt&order=createdAt.desc&limit=2`);
        if (!ms.length) break;
        if (ms[1] && (new Date(ms[0].createdAt) - new Date(ms[1].createdAt)) < 10 * 60 * 1000) { res.status(200).json({ skipped: 'recent' }); return; }
        subject = `New message from ${from.name}`;
        title = `${from.name} sent you a message`;
        paras = [`“${M.esc(String(ms[0].text).slice(0, 500))}”`];
        dash.text = 'Reply on Workar'; break;
      }
    }
    if (!subject) { res.status(400).json({ error: 'unknown event' }); return; }
    await M.sendMail(toEmail, subject, M.layout(title, paras, dash));
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
};
