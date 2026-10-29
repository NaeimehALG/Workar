process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Serverless Function: Stripe webhook. When a Checkout Session completes, this records the
// result in Supabase using the SERVICE ROLE key — which must only ever live here, as a Vercel
// Environment Variable, never in index.html or any client-side code.
//
// Also handles charge.dispute.created, charge.refunded and payment_intent.canceled (see handleMoneyEvent).
// Handles three kinds of purchase (set in metadata[kind] by /api/create-checkout):
//   booking    — marks the mentoring request as paid, records the mentor's share for the automatic
//                payout, creates the private call link, and emails mentor + client the link with a calendar invite
//   ai_credits — adds AI coaching messages to the buyer's profile
//   exam       — unlocks a PMP Prep mock exam (or the all-access pass) for the buyer
//
// Environment Variables in Vercel:
//   STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const crypto = require('crypto');

async function checkedFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error('database-write-failed');
  return response;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(p => {
    const i = p.indexOf('=');
    const k = p.slice(0, i), v = p.slice(i + 1);
    if (k === 'v1' && parts.v1) return; // keep the first v1 signature
    parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  // reject replays of old events (Stripe's recommended 5-minute tolerance)
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch (e) {
    return false;
  }
}

// ---------- money events after the payment: disputes, refunds, expired holds ----------
// Finds the booking, marks it, takes back the mentor's transfer when the money is gone, and leaves a
// money_alert row (agent_events) for the admin's daily digest. Returns a short text of what was done.
const idOf = x => (x && typeof x === 'object' ? x.id : x) || null;
async function findBooking(sb, h, { requestId, paymentIntent, charge }) {
  const tries = [];
  if (requestId) tries.push(`id=eq.${encodeURIComponent(requestId)}`);
  if (paymentIntent) tries.push(`stripePaymentIntentId=eq.${encodeURIComponent(paymentIntent)}`);
  if (charge) tries.push(`stripeChargeId=eq.${encodeURIComponent(charge)}`);
  for (const q of tries) {
    const r = await fetch(`${sb}/rest/v1/requests?${q}&select=*&limit=1`, { headers: h });
    if (!r.ok) throw new Error('database-read-failed ' + r.status);
    const rows = await r.json();
    if (rows && rows[0]) return rows[0];
  }
  return null;
}
async function patchBooking(sb, h, id, body) {
  const r = await fetch(`${sb}/rest/v1/requests?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, h), body: JSON.stringify(body) });
  if (!r.ok) throw new Error('database-write-failed ' + r.status);
}
const cad = c => 'CA$' + (Number(c || 0) / 100).toFixed(2);

async function handleMoneyEvent(event, sb, h) {
  const P = require('./_payouts');
  const o = event.data && event.data.object || {};
  const md = o.metadata || {};
  if (event.type === 'charge.dispute.created') {
    const r = await findBooking(sb, h, { paymentIntent: idOf(o.payment_intent), charge: idOf(o.charge) });
    if (!r) { await P.moneyAlert('evt:' + event.id, `Stripe dispute ${o.id} (${cad(o.amount)}) on charge ${idOf(o.charge)}: no Workar booking found. Check it in Stripe.`); return 'dispute-unmatched'; }
    await patchBooking(sb, h, r.id, { payoutError: 'the client disputed the payment' });
    let rev = '';
    try { const n = await P.reverseTransfers(r, 0, 'dispute'); if (n > 0) rev = ` Took back ${cad(n)} from the mentor's payout.`; }
    catch (e) { rev = ` Could not take back the mentor's payout (${String(e.message || e).slice(0, 120)}): do it in Stripe.`; }
    await P.moneyAlert('evt:' + event.id, `Dispute opened on booking ${r.id} (${cad(o.amount)}, reason: ${o.reason || 'unknown'}). Mentor payout blocked.${rev} Respond in Stripe before the deadline.`);
    return 'dispute';
  }
  if (event.type === 'charge.refunded') {
    const r = await findBooking(sb, h, { requestId: md.requestId, paymentIntent: idOf(o.payment_intent), charge: o.id });
    if (!r) return 'refund-unmatched';
    // a refund of some other payment for this booking (e.g. a duplicate checkout Workar released): not the booking's money
    const pi = idOf(o.payment_intent);
    if (!((pi && pi === r.stripePaymentIntentId) || (o.id && o.id === r.stripeChargeId))) return 'refund-other-payment';
    // Workar's own refunds: "Don't charge" (status refunded) and unused package sessions; the cron already handled the mentor side
    if (r.sessionsKept != null && (r.status === 'refunded' || P.chargeCovers(r, o))) return 'refund-own';
    const amount = Number(o.amount_captured != null ? o.amount_captured : o.amount) || 0;
    const left = Math.max(0, (Number(o.amount) || 0) - (Number(o.amount_refunded) || 0)); // uncaptured rest counts as refunded
    const keep = amount > 0 ? Math.min(1, left / amount) : 0;
    await patchBooking(sb, h, r.id, Object.assign({ payoutError: 'the payment was refunded' }, keep === 0 && r.holdStatus ? { holdStatus: 'refunded' } : {}));
    let rev = '';
    try { const n = await P.reverseTransfers(r, keep, 'refund-' + (Number(o.amount_refunded) || 0)); if (n > 0) rev = ` Took back ${cad(n)} from the mentor's payout.`; }
    catch (e) { rev = ` Could not take back the mentor's payout (${String(e.message || e).slice(0, 120)}): do it in Stripe.`; }
    await P.moneyAlert('evt:' + event.id, `Booking ${r.id} was refunded outside Workar's normal flow (${cad(o.amount_refunded)} of ${cad(amount)}). Mentor payout held.${rev}`);
    return 'refund';
  }
  if (event.type === 'payment_intent.canceled') {
    if (['abandoned', 'duplicate'].includes(o.cancellation_reason)) return 'cancel-own'; // Workar released it itself
    const r = await findBooking(sb, h, { paymentIntent: o.id });
    if (!r || r.stripePaymentIntentId !== o.id || r.holdStatus !== 'authorized') return 'cancel-ignored';
    await patchBooking(sb, h, r.id, { holdStatus: 'expired', holdError: 'the card hold was cancelled by Stripe (' + (o.cancellation_reason || 'expired') + ') before it was charged' });
    await P.moneyAlert('evt:' + event.id, `The card hold for booking ${r.id} (${cad(o.amount)}) was cancelled by Stripe (${o.cancellation_reason || 'expired'}) before it was charged. The client was not charged and the mentor will not be paid unless you arrange it.`);
    return 'hold-cancelled';
  }
  return 'ignored';
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'server-not-configured' });
    return;
  }

  const rawBody = await readRawBody(req);
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
    res.status(400).json({ error: 'invalid-signature' });
    return;
  }

  let event;
  try { event = JSON.parse(rawBody); } catch (e) {
    res.status(400).json({ error: 'invalid-json' });
    return;
  }

  const h = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json'
  };

  if (['charge.dispute.created', 'charge.refunded', 'payment_intent.canceled'].includes(event.type)) {
    try { const what = await handleMoneyEvent(event, supabaseUrl, h); res.status(200).json({ received: true, handled: what }); }
    catch (e) { console.error('money-event-failed', event.type, e.message); res.status(500).json({ error: 'update-failed' }); } // Stripe will retry
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};
    // Card-hold bookings: the card is held (or saved) now and charged only after the session — see api/_holds.js
    if (md.kind === 'booking' && md.holdMode) {
      const requestId = md.requestId || session.client_reference_id;
      try { if (requestId) await require('./_holds').secureFromSession(requestId, session); }
      catch (e) { console.error('hold-record-failed', e.message); res.status(500).json({ error: 'update-failed' }); return; } // Stripe will retry
      res.status(200).json({ received: true });
      return;
    }
    // only act on money that actually arrived (e.g. ignore delayed bank payments still pending)
    if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      res.status(200).json({ received: true, skipped: 'unpaid' }); return;
    }
    try {
      if (md.kind === 'exam' && md.userId && md.examId) {
        // stripeSessionId is unique, so a repeated webhook delivery is ignored
        await checkedFetch(`${supabaseUrl}/rest/v1/exam_purchases?on_conflict=stripeSessionId`, {
          method: 'POST',
          headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=minimal' }, h),
          body: JSON.stringify({ userId: md.userId, examId: md.examId, stripeSessionId: session.id })
        });
      } else if (md.kind === 'ai_credits' && md.userId) {
        // Atomic + idempotent: the purchase ledger keyed by Stripe session id means a re-sent webhook never grants twice.
        await checkedFetch(`${supabaseUrl}/rest/v1/rpc/grant_ai_credit_purchase`, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, h),
          body: JSON.stringify({ p_session_id: session.id, p_user_id: String(md.userId), p_credits: Number(md.credits) || 20 })
        });
      } else {
        const requestId = md.requestId || session.client_reference_id;
        if (requestId) {
          // only the first time it becomes paid (a re-sent webhook must not reset the payout bookkeeping)
          await checkedFetch(`${supabaseUrl}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}&paid=is.false`, {
            method: 'PATCH',
            headers: Object.assign({ Prefer: 'return=minimal' }, h),
            body: JSON.stringify(Object.assign(await require('./_payouts').paymentLockFields(), { paid: true, stripeSessionId: session.id }))
          });
          // lock in the mentor's share and remember the Stripe charge for the automatic payout later
          try {
            await require('./_payouts').recordPayment(requestId, session);
          } catch (e) { console.error('payout-record-failed', e); } // the daily payout run can recover the charge
          // private meeting link + confirmation email with calendar invite to BOTH people.
          // Runs once per booking (safe if Stripe re-sends the webhook) and never blocks the payment update.
          try {
            await require('./_session').confirmPaidSession(requestId);
          } catch (e) { console.error('session-confirm-failed', e); }
        }
      }
    } catch (e) {
      console.error('supabase-update-failed', e);
      res.status(500).json({ error: 'update-failed' }); // Stripe will retry
      return;
    }
  }

  res.status(200).json({ received: true });
}

module.exports = handler;
// Must be set AFTER module.exports is assigned, or Vercel ignores it
module.exports.config = { api: { bodyParser: false } };
module.exports.handleMoneyEvent = handleMoneyEvent;
