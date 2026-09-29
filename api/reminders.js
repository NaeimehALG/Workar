// Vercel Cron (see vercel.json): once a day, emails both people about sessions in the next ~30 hours.
// Protected with CRON_SECRET (Vercel sends it automatically when the env variable is set).
const M = require('./_mail');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) { res.status(401).end(); return; }
  const now = new Date(), soon = new Date(Date.now() + 30 * 3600 * 1000);
  const list = await M.rows(`requests?status=eq.accepted&remindedAt=is.null&startsAt=gte.${now.toISOString()}&startsAt=lte.${soon.toISOString()}&select=*`);
  let sent = 0;
  for (const r of list) {
    if (r.amountCents > 0 && !r.paid) continue;
    const [mentor, client] = await Promise.all([M.profile(r.mentorId), M.profile(r.clientId)]);
    for (const [who, other] of [[mentor, client], [client, mentor]]) {
      const email = await M.emailOf(who.id);
      await M.sendMail(email, `Reminder: your Workar session with ${other.name}`,
        M.layout('Your session is coming up', [`You're meeting <b>${M.esc(other.name)}</b> on <b>${M.esc(M.when(r, who.timezone))}</b>.`, 'At the session time, open Workar and press Join video call. Test your camera and microphone a few minutes before.'], { text: 'Open Workar', url: M.SITE() + '/?go=dashboard' }));
    }
    await M.patch(`requests?id=eq.${encodeURIComponent(r.id)}`, { remindedAt: new Date().toISOString() });
    sent++;
  }
  res.status(200).json({ reminded: sent });
};
