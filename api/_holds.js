process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Card holds for bookings (TaskRabbit-style): the client is charged only after the session happens.
//
//   1. When the mentor accepts, the client confirms with their card (api/create-checkout.js):
//        session within HOLD_NOW_DAYS → Stripe places a hold right away (manual capture)
//        session further away        → the card is only saved; no hold yet
//      Card holds expire after about 7 days (less for holds placed without the client present),
//      which is why far-away sessions are held later.
//   2. Every day (api/reminders.js → runHolds):
//        saved card, session within AUTH_AHEAD_HOURS → place the hold
//        session happened → charge (capture) the hold. "Happened" = the client confirmed it,
//            or CAPTURE_AFTER_HOURS passed after the start with no problem reported
//        mentor cancelled / declined / client cancelled in time / admin chose "don't charge" → release the hold
//        client cancelled less than LATE_CANCEL_HOURS before the start → charged (Refund policy)
//        a reported problem keeps the hold untouched until the admin decides
//        a hold that would expire before the session can be charged (e.g. rescheduled) → released and placed again later
//   3. The mentor's share is paid out later as before (api/_payouts.js → releaseDue), once the charge is captured.

const P = require('./_payouts');

const HOUR = 3600 * 1000;
const HOLD_NOW_DAYS = 4;          // hold at checkout when the session is this close
const AUTH_AHEAD_HOURS = 48;      // otherwise hold the saved card this long before the session
const CAPTURE_AFTER_HOURS = 24;   // client's window to report a problem after the start
const LATE_CANCEL_HOURS = 24;     // client cancellations closer than this are charged
const CRON_GAP_HOURS = 26;        // the daily job may not run again for this long
const CURRENCY = 'cad';

const SB = () => process.env.SUPABASE_URL;
const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' });
async function dbRows(path) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, { headers: svc() });
  if (!r.ok) throw new Error('database-read-failed ' + r.status);
  return r.json();
}
// Returns the updated rows, so callers can tell whether a guarded update actually happened
async function dbPatch(path, body) {
  const r = await fetch(`${SB()}/rest/v1/${path}`, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation' }, svc()), body: JSON.stringify(body) });
  if (!r.ok) throw new Error('database-write-failed ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  return r.json().catch(() => []);
}
const idq = id => `requests?id=eq.${encodeURIComponent(id)}`;

const ms = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : NaN; };
const startOf = r => ms(r.startsAt);

// Should checkout place the hold now (true) or only save the card (false)?
function holdNowAtCheckout(startsAt, now = Date.now()) {
  const s = ms(startsAt);
  return !Number.isFinite(s) || s - now <= HOLD_NOW_DAYS * 24 * HOUR;
}

function lateClientCancel(r) {
  if (r.status !== 'cancelled' || !r.cancelledBy || r.cancelledBy !== r.clientId) return false;
  const s = startOf(r), c = ms(r.cancelledAt);
  return Number.isFinite(s) && Number.isFinite(c) && s - c < LATE_CANCEL_HOURS * HOUR;
}

// What the daily job should do with one booking. Pure, so it can be tested.
//   authorize | charge (hold + capture at once) | capture | release | refund | rehold | warn-expiring | wait | none
function decide(r, now = Date.now()) {
  const hs = r.holdStatus;
  if (!hs || !['saved', 'authorized', 'captured'].includes(hs)) return 'none';
  const start = startOf(r);
  const cb = ms(r.holdCaptureBefore);

  if (['cancelled', 'declined', 'refunded'].includes(r.status)) {
    if (r.status === 'refunded') return hs === 'captured' ? 'refund' : 'release';
    if (lateClientCancel(r)) return hs === 'saved' ? 'charge' : hs === 'authorized' ? 'capture' : 'none';
    if (hs === 'captured') return 'none'; // money already taken: the admin decides about a refund
    return 'release';
  }
  if (hs === 'captured') return 'none';

  const problemOpen = !!(r.problemReportedAt && !r.problemResolvedAt);
  if (hs === 'saved') {
    if (!Number.isFinite(start) || start - now <= AUTH_AHEAD_HOURS * HOUR) return 'authorize';
    return 'wait';
  }
  // authorized
  const expiringSoon = Number.isFinite(cb) && cb - now < CRON_GAP_HOURS * HOUR;
  if (problemOpen) return expiringSoon ? 'warn-expiring' : 'wait';
  if (r.problemResolvedAt) return 'capture'; // the admin released the payout: the session counts
  if (!Number.isFinite(start)) {
    if (r.clientConfirmedAt || Number(r.sessionsDone) > 0 || expiringSoon) return 'capture';
    return 'wait';
  }
  if (start <= now) {
    if (r.clientConfirmedAt || now - start >= CAPTURE_AFTER_HOURS * HOUR || expiringSoon) return 'capture';
    return 'wait';
  }
  // session still ahead: will the hold last until we can charge it?
  if (Number.isFinite(cb) && cb < start + (CAPTURE_AFTER_HOURS + CRON_GAP_HOURS) * HOUR) return 'rehold';
  return 'wait';
}

// ---------- Stripe helpers ----------
function captureBeforeOf(pi) {
  const ch = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const t = ch && ch.payment_method_details && ch.payment_method_details.card && ch.payment_method_details.card.capture_before;
  return t ? new Date(t * 1000).toISOString() : null;
}
const idOf = x => (x && typeof x === 'object' ? x.id : x) || null;

// One Stripe customer per Workar user, so the card can be held again later without the client present
async function customerFor(user) {
  try {
    const rows = await dbRows(`stripe_customers?userId=eq.${encodeURIComponent(user.id)}&select=customerId`);
    if (rows[0] && rows[0].customerId) {
      try { const c = await P.stripe('GET', 'customers/' + encodeURIComponent(rows[0].customerId)); if (c && !c.deleted) return c.id; } catch (e) {}
    }
  } catch (e) { console.error('customer-lookup-failed', e.message); }
  const c = await P.stripe('POST', 'customers', { email: user.email || undefined, metadata: { workarUserId: user.id } }, 'workar-customer-' + user.id + '-' + new Date().toISOString().slice(0, 10));
  try {
    await fetch(`${SB()}/rest/v1/stripe_customers?on_conflict=userId`, { method: 'POST', headers: Object.assign({ Prefer: 'resolution=merge-duplicates,return=minimal' }, svc()), body: JSON.stringify({ userId: user.id, customerId: c.id }) });
  } catch (e) { console.error('customer-save-failed', e.message); }
  return c.id;
}

// ---------- after Checkout: record the hold or the saved card ----------
// Used by the Stripe webhook and by the backup check (P.confirmPayment). Safe to call twice.
async function secureFromSession(requestId, session) {
  const md = session.metadata || {};
  if (session.status && session.status !== 'complete') return { paid: false };
  const upd = { paid: true, stripeSessionId: session.id, holdAt: new Date().toISOString(), holdError: null };
  if (session.mode === 'setup') {
    const si = await P.stripe('GET', 'setup_intents/' + encodeURIComponent(idOf(session.setup_intent)));
    if (si.status !== 'succeeded') return { paid: false };
    Object.assign(upd, { holdStatus: 'saved', stripeCustomerId: idOf(si.customer) || idOf(session.customer), stripePaymentMethodId: idOf(si.payment_method), holdAmountCents: Number(md.amountCents) || null, stripePaymentIntentId: null, holdCaptureBefore: null });
  } else {
    const pi = await P.stripe('GET', 'payment_intents/' + encodeURIComponent(idOf(session.payment_intent)), { expand: ['latest_charge'] });
    if (pi.status !== 'requires_capture' && pi.status !== 'succeeded') return { paid: false };
    Object.assign(upd, {
      holdStatus: pi.status === 'succeeded' ? 'captured' : 'authorized',
      stripePaymentIntentId: pi.id, stripeCustomerId: idOf(pi.customer), stripePaymentMethodId: idOf(pi.payment_method),
      holdAmountCents: pi.amount, holdCaptureBefore: captureBeforeOf(pi)
    });
    if (pi.status === 'succeeded') upd.capturedAt = new Date().toISOString();
  }
  // Keep the booking's price equal to what the card was actually held or charged for.
  const charged = session.mode === 'setup' ? Number(md.amountCents) : Number(upd.holdAmountCents);
  if (Number.isSafeInteger(charged) && charged > 0) upd.amountCents = charged;
  const changed = await dbPatch(`${idq(requestId)}&paid=is.false`, upd);
  if (!changed.length) {
    // The booking was already paid through another checkout (two tabs, back button). Release this
    // second payment so the client's card isn't held or charged twice.
    if (session.mode !== 'setup' && upd.stripePaymentIntentId) {
      try {
        const row = (await dbRows(`${idq(requestId)}&select=stripeSessionId,stripePaymentIntentId`))[0] || {};
        if (row.stripeSessionId !== session.id && row.stripePaymentIntentId !== upd.stripePaymentIntentId) {
          const pid = upd.stripePaymentIntentId;
          if (upd.holdStatus === 'authorized') await P.stripe('POST', 'payment_intents/' + encodeURIComponent(pid) + '/cancel', {}, 'workar-dup-cancel-' + pid);
          else await P.stripe('POST', 'refunds', { payment_intent: pid }, 'workar-dup-refund-' + pid);
          console.log('duplicate-checkout-released', requestId, pid);
        }
      } catch (e) { console.error('duplicate-checkout-release-failed', requestId, e.message); }
    }
    return { paid: true, already: true };
  }
  if (upd.holdStatus === 'captured') { try { await P.recordPayment(requestId, { amount_total: upd.holdAmountCents, payment_intent: upd.stripePaymentIntentId }); } catch (e) { console.error('payout-record-failed', e.message); } }
  try { await require('./_session').confirmPaidSession(requestId); } catch (e) { console.error('session-confirm-failed', e); }
  return { paid: true, holdStatus: upd.holdStatus };
}

// ---------- the daily job ----------
async function authorize(r, { charge = false } = {}) {
  const amount = Number(r.holdAmountCents) || Number(r.amountCents) || 0;
  if (!(amount >= 50)) throw new Error('booking has no amount to hold');
  if (!r.stripeCustomerId || !r.stripePaymentMethodId) throw new Error('no saved card for this booking');
  const params = {
    amount, currency: CURRENCY, customer: r.stripeCustomerId, payment_method: r.stripePaymentMethodId,
    off_session: true, confirm: true, capture_method: charge ? 'automatic' : 'manual',
    description: charge ? 'Workar session (late cancellation)' : 'Workar mentoring session',
    metadata: { requestId: r.id, kind: 'booking' }, expand: ['latest_charge']
  };
  const key = `workar-hold-${r.id}-${charge ? 'charge' : 'auth'}-${r.startsAt || ''}-${r.stripePaymentIntentId || 'first'}`;
  const pi = await P.stripe('POST', 'payment_intents', params, key);
  if (charge && pi.status === 'succeeded') {
    await dbPatch(idq(r.id), { holdStatus: 'captured', stripePaymentIntentId: pi.id, capturedAt: new Date().toISOString(), holdAmountCents: amount, holdError: null, stripeChargeId: idOf(pi.latest_charge) });
    await P.recordPayment(r.id, { amount_total: pi.amount_received || amount, payment_intent: pi.id });
    return 'captured';
  }
  if (pi.status !== 'requires_capture') throw Object.assign(new Error('the card could not be held (' + pi.status + ')'), { card: true });
  await dbPatch(idq(r.id), { holdStatus: 'authorized', stripePaymentIntentId: pi.id, holdCaptureBefore: captureBeforeOf(pi), holdAt: new Date().toISOString(), holdAmountCents: amount, holdError: null });
  return 'authorized';
}

async function capture(r) {
  let pi;
  try {
    pi = await P.stripe('POST', `payment_intents/${encodeURIComponent(r.stripePaymentIntentId)}/capture`, { expand: ['latest_charge'] }, 'workar-capture-' + r.stripePaymentIntentId);
  } catch (e) {
    const cur = await P.stripe('GET', 'payment_intents/' + encodeURIComponent(r.stripePaymentIntentId), { expand: ['latest_charge'] }).catch(() => null);
    if (cur && cur.status === 'succeeded') pi = cur;
    else if (cur && cur.status === 'canceled') {
      await dbPatch(idq(r.id), { holdStatus: 'expired', holdError: 'the card hold expired before it was charged' });
      throw new Error('the card hold expired before it could be charged — the client was not charged');
    } else throw e;
  }
  await dbPatch(idq(r.id), { holdStatus: 'captured', capturedAt: new Date().toISOString(), holdError: null });
  await P.recordPayment(r.id, { amount_total: pi.amount_received || pi.amount, payment_intent: pi.id });
  return pi;
}

async function cancelHold(r) {
  if (!r.stripePaymentIntentId) return;
  try { await P.stripe('POST', `payment_intents/${encodeURIComponent(r.stripePaymentIntentId)}/cancel`, {}, 'workar-release-' + r.stripePaymentIntentId); }
  catch (e) {
    const cur = await P.stripe('GET', 'payment_intents/' + encodeURIComponent(r.stripePaymentIntentId)).catch(() => null);
    if (!cur || cur.status !== 'canceled') throw e;
  }
}

async function release(r) {
  if (r.holdStatus === 'authorized') await cancelHold(r);
  await dbPatch(idq(r.id), { holdStatus: 'released', holdError: null });
}

async function rehold(r) {
  await cancelHold(r);
  await dbPatch(idq(r.id), { holdStatus: 'saved', stripePaymentIntentId: null, holdCaptureBefore: null });
}

async function refund(r) {
  if (r.stripeTransferId || r.payoutDone) throw new Error('the mentor was already paid for this booking — refund it in Stripe and recover the transfer by hand');
  await P.stripe('POST', 'refunds', { payment_intent: r.stripePaymentIntentId, metadata: { requestId: r.id } }, 'workar-refund-' + r.stripePaymentIntentId);
  await dbPatch(idq(r.id), { holdStatus: 'refunded', holdError: null });
}

async function cardFailed(r, err, mail) {
  const msg = String((err && err.message) || err || 'card declined').slice(0, 300);
  await dbPatch(idq(r.id), { holdStatus: 'failed', holdError: msg, paid: false, stripeSessionId: null, stripePaymentIntentId: null });
  if (mail) { try { await mail('card-failed', r); } catch (e) { console.error('card-failed-mail', r.id, e.message); } }
}

async function runHolds({ mail } = {}) {
  const out = { held: 0, charged: 0, released: 0, refunded: 0, reheld: 0, cardFailed: 0, problems: [] };
  if (!process.env.STRIPE_SECRET_KEY) return out;
  let list;
  try { list = await dbRows('requests?holdStatus=in.(saved,authorized,captured)&select=*'); }
  catch (e) { out.problems.push('Card holds: could not read bookings — has supabase-holds.sql been run? (' + e.message + ')'); return out; }
  const now = Date.now();
  for (const r of list) {
    const what = decide(r, now);
    if (what === 'none' || what === 'wait') continue;
    const label = `booking ${r.id}`;
    try {
      if (what === 'authorize') {
        try { await authorize(r); out.held++; }
        catch (e) {
          if (e.card || (e.stripe && /card|decline|authentication|insufficient|expired/i.test((e.code || '') + ' ' + e.message))) { await cardFailed(r, e, mail); out.cardFailed++; }
          else throw e;
        }
      } else if (what === 'charge') {
        try { await authorize(r, { charge: true }); out.charged++; }
        catch (e) { if (e.stripe) { await dbPatch(idq(r.id), { holdStatus: 'failed', holdError: String(e.message).slice(0, 300) }); out.problems.push(`Late-cancellation charge failed for ${label}: ${e.message}`); } else throw e; }
      } else if (what === 'capture') { await capture(r); out.charged++; }
      else if (what === 'release') { await release(r); out.released++; }
      else if (what === 'rehold') { await rehold(r); out.reheld++; }
      else if (what === 'refund') { await refund(r); out.refunded++; }
      else if (what === 'warn-expiring') {
        out.problems.push(`The card hold for ${label} expires ${r.holdCaptureBefore ? 'on ' + new Date(r.holdCaptureBefore).toUTCString() : 'soon'} and the client reported a problem. In Admin → Mentor payouts choose "Release payout" to charge the client, or "Don't charge" to release the hold. If nothing is chosen, the hold expires and the client is not charged.`);
      }
    } catch (e) {
      console.error('hold-step-failed', what, r.id, e.message);
      try { await dbPatch(idq(r.id), { holdError: String(e.message || e).slice(0, 300) }); } catch (x) {}
      out.problems.push(`Card hold step "${what}" failed for ${label}: ${e.message || e}`);
    }
  }
  return out;
}

module.exports = {
  HOLD_NOW_DAYS, AUTH_AHEAD_HOURS, CAPTURE_AFTER_HOURS, LATE_CANCEL_HOURS,
  holdNowAtCheckout, lateClientCancel, decide, customerFor, secureFromSession, runHolds, captureBeforeOf
};
