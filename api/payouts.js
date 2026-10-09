process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Serverless Function: a mentor's payout (bank) setup with Stripe Connect.
//   POST { action: "start", country: "CA" } → { url } Stripe's hosted bank-setup page
//   POST { action: "status" }               → { connected, enabled, needsInfo }
//   POST { action: "dashboard" }            → { url } Stripe Express dashboard (payout history, bank details)
// The money itself is sent by the daily cron (see api/_payouts.js).
const M = require('./_mail');
const P = require('./_payouts');

// Countries offered in the mentor's bank-setup form. Stripe has the final say on what it supports.
const COUNTRIES = ['CA', 'US', 'GB', 'AU', 'NZ', 'IE', 'DE', 'FR', 'NL', 'BE', 'AT', 'CH', 'ES', 'IT', 'PT', 'SE', 'DK', 'NO', 'FI', 'AE', 'SG'];

function friendly(e) {
  const msg = String((e && e.message) || e);
  if (/signed up for Connect|platform.*profile|connect.*not enabled/i.test(msg)) return { status: 503, error: 'connect-not-enabled' };
  if (e && e.stripe && /country|not supported|cross-border|recipient/i.test(msg)) return { status: 400, error: 'country-not-supported' };
  if (e && e.code === 'not-configured') return { status: 503, error: 'server-not-configured' };
  return { status: 502, error: 'stripe-error' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.STRIPE_SECRET_KEY) { res.status(503).json({ error: 'server-not-configured' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { action, country } = body || {};

  let me;
  try { me = await M.userFromToken(String((req.headers || {}).authorization || '').replace(/^Bearer\s+/i, '')); }
  catch (e) { res.status(503).json({ error: 'authentication-unavailable' }); return; }
  if (!me || !me.id) { res.status(401).json({ error: 'sign-in-required' }); return; }
  const prof = (await M.rows(`profiles?id=eq.${encodeURIComponent(me.id)}&select=id,role`))[0];
  if (!prof || prof.role !== 'mentor') { res.status(403).json({ error: 'mentors-only' }); return; }

  try {
    const row = await P.accountRow(me.id);
    if (action === 'status') {
      if (!row) { res.status(200).json({ connected: false, enabled: false }); return; }
      res.status(200).json(await P.refreshStatus(row)); return;
    }
    if (action === 'dashboard') {
      if (!row) { res.status(409).json({ error: 'not-connected' }); return; }
      const st = await P.refreshStatus(row);
      if (!st.enabled) { res.status(409).json({ error: 'setup-not-finished' }); return; }
      res.status(200).json({ url: await P.dashboardLink(row.stripeAccountId) }); return;
    }
    if (action === 'start') {
      let acctId = row && row.stripeAccountId;
      if (!acctId) {
        const c = String(country || '').toUpperCase();
        if (!COUNTRIES.includes(c)) { res.status(400).json({ error: 'country-not-supported' }); return; }
        acctId = await P.createAccount({ mentorId: me.id, email: me.email, country: c });
      }
      res.status(200).json({ url: await P.onboardingLink(acctId, M.SITE()) }); return;
    }
    res.status(400).json({ error: 'unknown-action' });
  } catch (e) {
    console.error('payouts-endpoint-failed', action, e.message);
    const f = friendly(e);
    res.status(f.status).json({ error: f.error });
  }
};
module.exports.COUNTRIES = COUNTRIES;
