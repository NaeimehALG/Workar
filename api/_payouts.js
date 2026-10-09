process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Automatic mentor payouts with Stripe Connect (Express accounts).
//
// How money moves:
//   1. The client pays Workar through Stripe Checkout (api/create-checkout.js).
//   2. The webhook records the Stripe charge and locks in the mentor's share at that moment
//      (recordPayment), so changing the commission later never changes past bookings.
//   3. Once a day the cron (api/reminders.js → releaseDue) sends each mentor their share,
//      HOLD_HOURS after the session, if the booking wasn't refunded or disputed and the mentor
//      has finished their 5-minute Stripe bank setup. Mentors who haven't set up yet get one
//      friendly email per booking; their money waits until they do.
//
// Environment Variables in Vercel: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: PLATFORM_COUNTRY (country of Workar's own Stripe account, default CA)

const HOLD_HOURS = 48;
const DEFAULT_MENTOR_SHARE = 70; // must match mentorSharePct() in index.html
const PKG_SESSIONS = { single: 1, resume: 2, interview: 3, offer: 6 };
const MAX_PER_RUN = 25;

const SB = () => process.env.SUPABASE_URL;
const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' });

async function dbRows(path) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, { headers: svc() });
  if (!r.ok) throw new Error('database-read-failed ' + r.status);
  return r.json();
}
async function dbPatch(path, body) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, svc()), body: JSON.stringify(body) });
  if (!r.ok) throw new Error('database-write-failed ' + r.status);
}
async function dbInsert(table, body) {
  const r = await fetch(`${SB()}/rest/v1/${table}`, { method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, svc()), body: JSON.stringify(body) });
  if (!r.ok) throw new Error('database-write-failed ' + r.status);
}

// Minimal Stripe client (form-encoded, like the rest of Workar's Stripe code)
function form(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((x, i) => out.append(`${key}[${i}]`, String(x)));
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, path, params, idempotencyKey) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw Object.assign(new Error('STRIPE_SECRET_KEY is not set'), { code: 'not-configured' });
  const headers = { Authorization: 'Bearer ' + key };
  let url = 'https://api.stripe.com/v1/' + path, body;
  if (method === 'GET') { const q = form(params).toString(); if (q) url += '?' + q; }
  else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = form(params).toString(); }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const r = await fetch(url, { method, headers, body });
  const data = await r.json();
  if (!r.ok) {
    const err = new Error((data && data.error && data.error.message) || ('stripe-error ' + r.status));
    err.code = data && data.error && data.error.code; err.stripe = true;
    throw err;
  }
  return data;
}

async function mentorSharePct() {
  try {
    const st = await dbRows('site_settings?id=eq.main&select=data');
    const v = Number(st && st[0] && st[0].data && st[0].data.mentorShare);
    if (v > 0 && v <= 100) return v;
  } catch (e) {}
  return DEFAULT_MENTOR_SHARE;
}

// ---------- step 2: called by the Stripe webhook when a booking is paid ----------
async function recordPayment(requestId, session) {
  const amount = Number(session.amount_total) || 0;
  const share = await mentorSharePct();
  const upd = { payoutCents: Math.round(amount * share / 100) };
  if (session.payment_intent) {
    try {
      const pi = await stripe('GET', 'payment_intents/' + encodeURIComponent(session.payment_intent));
      if (pi.latest_charge) upd.stripeChargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id;
    } catch (e) { console.error('charge-lookup-failed', requestId, e.message); } // found again later by releaseDue
  }
  await dbPatch(`requests?id=eq.${encodeURIComponent(requestId)}&stripeTransferId=is.null`, upd);
  return upd;
}

// ---------- mentor bank setup ----------
async function accountRow(mentorId) {
  const rows = await dbRows(`mentor_payout_accounts?mentorId=eq.${encodeURIComponent(mentorId)}&select=*`);
  return rows[0] || null;
}

function isReady(acct) {
  return !!(acct && acct.payouts_enabled && acct.capabilities && acct.capabilities.transfers === 'active');
}

async function refreshStatus(row) {
  const acct = await stripe('GET', 'accounts/' + encodeURIComponent(row.stripeAccountId));
  const enabled = isReady(acct);
  if (enabled !== !!row.payoutsEnabled) {
    await dbPatch(`mentor_payout_accounts?mentorId=eq.${encodeURIComponent(row.mentorId)}`, { payoutsEnabled: enabled, updatedAt: new Date().toISOString() });
  }
  const due = (acct.requirements && acct.requirements.currently_due) || [];
  return { connected: true, enabled, needsInfo: !enabled && (due.length > 0 || !acct.details_submitted) };
}

async function createAccount({ mentorId, email, country }) {
  const platform = String(process.env.PLATFORM_COUNTRY || 'CA').toUpperCase();
  const params = {
    type: 'express',
    country,
    email: email || undefined,
    business_type: 'individual',
    capabilities: { transfers: { requested: true } },
    business_profile: { product_description: 'Career mentoring sessions sold on Workar (workar.me)', url: 'https://workar.me' },
    metadata: { workarUserId: mentorId }
  };
  // Mentors outside Workar's own country can only receive money (not take card payments themselves)
  if (country !== platform) params.tos_acceptance = { service_agreement: 'recipient' };
  const acct = await stripe('POST', 'accounts', params, 'workar-acct-' + mentorId + '-' + country);
  await dbInsert('mentor_payout_accounts', { mentorId, stripeAccountId: acct.id, country, payoutsEnabled: false });
  return acct.id;
}

async function onboardingLink(stripeAccountId, site) {
  const link = await stripe('POST', 'account_links', {
    account: stripeAccountId,
    type: 'account_onboarding',
    refresh_url: site + '/?payouts=refresh',
    return_url: site + '/?payouts=done'
  });
  return link.url;
}

async function dashboardLink(stripeAccountId) {
  const link = await stripe('POST', `accounts/${encodeURIComponent(stripeAccountId)}/login_links`, {});
  return link.url;
}

// ---------- step 3: the daily release ----------
function sessionsIn(r) { return Number(r.sessions) || PKG_SESSIONS[r.packageKey] || 1; }

// A booking is ready to pay out once its (last) session is safely in the past.
function isReleasable(r, now = Date.now()) {
  if (!r.paid || r.payoutDone || r.stripeTransferId || !(Number(r.amountCents) > 0)) return false;
  if (['cancelled', 'declined', 'refunded'].includes(r.status)) return false;
  const start = r.startsAt ? Date.parse(r.startsAt) : NaN;
  if (!Number.isFinite(start) || now - start < HOLD_HOURS * 3600 * 1000) return false;
  // multi-session packages wait until the mentor has marked every session done
  const total = sessionsIn(r);
  if (total > 1 && (Number(r.sessionsDone) || 0) < total) return false;
  return true;
}

async function chargeFor(r) {
  if (r.stripeChargeId) return r.stripeChargeId;
  if (!r.stripeSessionId) return null;
  const s = await stripe('GET', 'checkout/sessions/' + encodeURIComponent(r.stripeSessionId), { expand: ['payment_intent'] });
  const pi = s.payment_intent;
  const id = pi && (typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge && pi.latest_charge.id);
  if (id) await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { stripeChargeId: id });
  return id || null;
}

async function releaseDue({ sendMail } = {}) {
  const out = { paidOut: 0, paidOutCents: 0, waitingForBank: [], problems: [] };
  if (!process.env.STRIPE_SECRET_KEY) return out;
  const share = await mentorSharePct();
  const list = (await dbRows('requests?paid=eq.true&stripeTransferId=is.null&or=(payoutDone.is.null,payoutDone.eq.false)&select=*'))
    .filter(r => isReleasable(r)).slice(0, MAX_PER_RUN);
  const accounts = {};
  for (const r of list) {
    const label = `booking ${r.id}`;
    try {
      if (!(r.mentorId in accounts)) {
        const row = await accountRow(r.mentorId);
        accounts[r.mentorId] = row && !row.payoutsEnabled ? Object.assign(row, { payoutsEnabled: (await refreshStatus(row)).enabled }) : row;
      }
      const acct = accounts[r.mentorId];
      const mentorCents = Number.isFinite(Number(r.payoutCents)) && r.payoutCents != null ? Number(r.payoutCents) : Math.round(Number(r.amountCents) * share / 100);
      if (!acct || !acct.payoutsEnabled) {
        out.waitingForBank.push({ requestId: r.id, mentorId: r.mentorId, cents: mentorCents });
        if (!r.payoutNudgedAt && sendMail) {
          await sendMail('bank-needed', r, mentorCents);
          await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { payoutNudgedAt: new Date().toISOString() });
        }
        continue;
      }
      const chargeId = await chargeFor(r);
      if (!chargeId) throw new Error('no Stripe charge found for this booking');
      const charge = await stripe('GET', 'charges/' + encodeURIComponent(chargeId), { expand: ['balance_transaction'] });
      if (charge.refunded || Number(charge.amount_refunded) > 0 || charge.disputed) {
        const why = charge.disputed ? 'the client disputed the payment' : 'the payment was refunded';
        if (r.payoutError !== why) await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { payoutError: why });
        out.problems.push(`Payout held for ${label}: ${why}. Check it in the admin panel.`);
        continue;
      }
      // Pay in the currency the money actually settled in (a USD charge may settle as CAD).
      const bt = charge.balance_transaction && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
      const currency = (bt && bt.currency) || charge.currency;
      const amount = bt && bt.currency !== charge.currency
        ? Math.floor(Number(bt.amount) * mentorCents / Number(charge.amount))
        : mentorCents;
      if (!(amount > 0)) throw new Error('payout amount is zero');
      const tr = await stripe('POST', 'transfers', {
        amount, currency,
        destination: acct.stripeAccountId,
        source_transaction: chargeId,
        transfer_group: 'booking_' + r.id,
        description: 'Workar mentoring payout',
        metadata: { requestId: r.id, mentorId: r.mentorId }
      }, 'workar-payout-' + r.id);
      await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, {
        stripeTransferId: tr.id, payoutDone: true, payoutAt: new Date().toISOString(), payoutCents: mentorCents, payoutError: null
      });
      out.paidOut++; out.paidOutCents += mentorCents;
      if (sendMail) { try { await sendMail('paid', r, mentorCents); } catch (e) { console.error('payout-email-failed', r.id, e.message); } }
    } catch (e) {
      console.error('payout-failed', r.id, e.message);
      try { await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { payoutError: String(e.message || e).slice(0, 300) }); } catch (x) {}
      out.problems.push(`Payout failed for ${label}: ${e.message || e}`);
    }
  }
  return out;
}

module.exports = {
  HOLD_HOURS, DEFAULT_MENTOR_SHARE, stripe, form, mentorSharePct, recordPayment,
  accountRow, refreshStatus, createAccount, onboardingLink, dashboardLink, isReady, isReleasable, releaseDue
};
