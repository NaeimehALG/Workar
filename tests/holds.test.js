const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../api/_holds');
const P = require('../api/_payouts');

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const now = Date.parse('2026-10-11T15:00:00Z');
const at = ms => new Date(now + ms).toISOString();
const base = (o = {}) => Object.assign({ id: 'r1', clientId: 'c', mentorId: 'm', status: 'accepted', paid: true, amountCents: 3000 }, o);

test('checkout holds now for close sessions and saves the card for far ones', () => {
  assert.equal(H.holdNowAtCheckout(at(2 * DAY), now), true);
  assert.equal(H.holdNowAtCheckout(at(4 * DAY), now), true);
  assert.equal(H.holdNowAtCheckout(at(4 * DAY + HOUR), now), false);
  assert.equal(H.holdNowAtCheckout(null, now), true);
});

test('saved cards are held about two days before the session', () => {
  assert.equal(H.decide(base({ holdStatus: 'saved', startsAt: at(5 * DAY) }), now), 'wait');
  assert.equal(H.decide(base({ holdStatus: 'saved', startsAt: at(47 * HOUR) }), now), 'authorize');
  assert.equal(H.decide(base({ holdStatus: 'saved', startsAt: at(-HOUR) }), now), 'authorize');
});

test('a hold is charged only after the session happened', () => {
  const r = base({ holdStatus: 'authorized', startsAt: at(-2 * HOUR), holdCaptureBefore: at(4 * DAY) });
  assert.equal(H.decide(r, now), 'wait');                                              // still inside the problem window
  assert.equal(H.decide(Object.assign({}, r, { clientConfirmedAt: at(-HOUR) }), now), 'capture'); // client confirmed
  assert.equal(H.decide(Object.assign({}, r, { startsAt: at(-25 * HOUR) }), now), 'capture');      // 24h passed
  assert.equal(H.decide(base({ holdStatus: 'authorized', startsAt: at(DAY), holdCaptureBefore: at(6 * DAY) }), now), 'wait');
});

test('a reported problem blocks the charge until the admin decides', () => {
  const r = base({ holdStatus: 'authorized', startsAt: at(-30 * HOUR), holdCaptureBefore: at(3 * DAY), problemReportedAt: at(-20 * HOUR) });
  assert.equal(H.decide(r, now), 'wait');
  assert.equal(H.decide(Object.assign({}, r, { holdCaptureBefore: at(10 * HOUR) }), now), 'warn-expiring');
  assert.equal(H.decide(Object.assign({}, r, { problemResolvedAt: at(-HOUR) }), now), 'capture');            // admin: Release payout
  assert.equal(H.decide(Object.assign({}, r, { status: 'refunded', problemResolvedAt: at(-HOUR) }), now), 'release'); // admin: Don't charge
  assert.equal(H.decide(Object.assign({}, r, { holdStatus: 'captured', status: 'refunded' }), now), 'refund');
});

test('cancellations: mentor or early client cancel releases, late client cancel is charged', () => {
  const r = base({ holdStatus: 'authorized', startsAt: at(10 * HOUR), status: 'cancelled' });
  assert.equal(H.decide(Object.assign({}, r, { cancelledBy: 'm', cancelledAt: at(-HOUR) }), now), 'release');
  assert.equal(H.decide(Object.assign({}, r, { cancelledBy: 'c', cancelledAt: at(-HOUR) }), now), 'capture');
  assert.equal(H.decide(Object.assign({}, r, { cancelledBy: 'c', cancelledAt: at(-2 * DAY) }), now), 'release');
  assert.equal(H.decide(Object.assign({}, r, { holdStatus: 'saved', cancelledBy: 'c', cancelledAt: at(-HOUR) }), now), 'charge');
  assert.equal(H.decide(base({ holdStatus: 'saved', status: 'declined', startsAt: at(3 * DAY) }), now), 'release');
});

test('a hold that would expire before the session can be charged is placed again', () => {
  // rescheduled to 5 days out while holding a card whose hold ends in 3 days
  const r = base({ holdStatus: 'authorized', startsAt: at(5 * DAY), holdCaptureBefore: at(3 * DAY) });
  assert.equal(H.decide(r, now), 'rehold');
});

test('a hold close to expiry after the session is charged without waiting the full day', () => {
  const r = base({ holdStatus: 'authorized', startsAt: at(-3 * HOUR), holdCaptureBefore: at(12 * HOUR) });
  assert.equal(H.decide(r, now), 'capture');
});

test('mentor payouts wait until the card is actually charged', () => {
  const r = { paid: true, amountCents: 3000, status: 'accepted', startsAt: new Date(Date.now() - 10 * DAY).toISOString() };
  assert.equal(P.isReleasable(Object.assign({}, r)), true);                              // older bookings: charged at checkout
  assert.equal(P.isReleasable(Object.assign({}, r, { holdStatus: 'authorized' })), false);
  assert.equal(P.isReleasable(Object.assign({}, r, { holdStatus: 'captured' })), true);
  assert.equal(P.isReleasable(Object.assign({}, r, { holdStatus: 'released' })), false);
  assert.equal(P.isReleasable(Object.assign({}, r, { holdStatus: 'captured', status: 'cancelled' })), true); // late cancellation is paid
  assert.equal(P.isReleasable(Object.assign({}, r, { holdStatus: 'captured', status: 'refunded' })), false);
});

// ---------- flows against a fake Stripe + database ----------
function fakeWorld(rows) {
  const calls = [];
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body || '';
    calls.push({ url, method, body });
    const j = (data, ok = true) => ({ ok, status: ok ? 200 : 402, json: async () => data, text: async () => JSON.stringify(data) });
    if (url.includes('api.stripe.com')) {
      if (url.includes('/setup_intents/')) return j({ id: 'seti_1', status: 'succeeded', customer: 'cus_1', payment_method: 'pm_1' });
      if (/payment_intents\/pi_\w+\/capture/.test(url)) return j({ id: 'pi_hold', status: 'succeeded', amount: 6000, amount_received: 6000, latest_charge: { id: 'ch_1' } });
      if (/payment_intents\/pi_\w+\/cancel/.test(url)) return j({ id: 'pi_hold', status: 'canceled' });
      if (url.includes('/payment_intents/')) return j({ id: 'pi_hold', status: 'requires_capture', amount: 6000, customer: 'cus_1', payment_method: 'pm_1', latest_charge: { id: 'ch_1', payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 6 * 86400 } } } });
      if (url.endsWith('/payment_intents') && method === 'POST') {
        if (body.includes('pm_declined')) return j({ error: { code: 'card_declined', message: 'Your card was declined.' } }, false);
        return j({ id: 'pi_new', status: 'requires_capture', amount: 6000, latest_charge: { id: 'ch_2', payment_method_details: { card: { capture_before: Math.floor(Date.now() / 1000) + 4 * 86400 } } } });
      }
      return j({});
    }
    if (url.includes('/rest/v1/requests') && method === 'GET') return j(rows);
    if (url.includes('/rest/v1/site_settings')) return j([]);
    if (url.includes('/rest/v1/requests') && method === 'PATCH') return j([Object.assign({ id: 'r1' }, JSON.parse(body))]);
    return j([]);
  };
  return calls;
}
const patches = calls => calls.filter(c => c.method === 'PATCH' && c.url.includes('/requests')).map(c => JSON.parse(c.body));

test('a completed setup checkout saves the card and confirms the booking without charging', async () => {
  const calls = fakeWorld([]);
  const out = await H.secureFromSession('r1', { id: 'cs_1', mode: 'setup', status: 'complete', setup_intent: 'seti_1', metadata: { holdMode: 'later', amountCents: '6000' } });
  assert.equal(out.paid, true);
  const p = patches(calls)[0];
  assert.equal(p.holdStatus, 'saved'); assert.equal(p.stripePaymentMethodId, 'pm_1'); assert.equal(p.holdAmountCents, 6000); assert.equal(p.paid, true);
  assert.ok(!calls.some(c => c.url.includes('/capture')));
});

test('a completed hold checkout records the authorization and its expiry', async () => {
  const calls = fakeWorld([]);
  await H.secureFromSession('r1', { id: 'cs_1', mode: 'payment', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_hold', metadata: { holdMode: 'now' } });
  const p = patches(calls)[0];
  assert.equal(p.holdStatus, 'authorized'); assert.equal(p.stripePaymentIntentId, 'pi_hold'); assert.ok(p.holdCaptureBefore);
});

test('daily run: holds a saved card, charges a finished session, releases a mentor cancellation', async () => {
  const rows = [
    base({ id: 'a', holdStatus: 'saved', startsAt: new Date(Date.now() + 30 * HOUR).toISOString(), stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1', holdAmountCents: 6000 }),
    base({ id: 'b', holdStatus: 'authorized', stripePaymentIntentId: 'pi_hold', startsAt: new Date(Date.now() - 30 * HOUR).toISOString(), holdCaptureBefore: new Date(Date.now() + 3 * DAY).toISOString() }),
    base({ id: 'c', holdStatus: 'authorized', stripePaymentIntentId: 'pi_hold', status: 'cancelled', cancelledBy: 'm', cancelledAt: new Date().toISOString(), startsAt: new Date(Date.now() + DAY).toISOString() })
  ];
  const calls = fakeWorld(rows);
  const out = await H.runHolds({});
  assert.deepEqual([out.held, out.charged, out.released, out.problems.length], [1, 1, 1, 0]);
  assert.ok(calls.some(c => c.url.endsWith('/payment_intents') && c.body.includes('capture_method=manual') && c.body.includes('off_session=true')));
  assert.ok(calls.some(c => c.url.includes('pi_hold/capture')));
  assert.ok(calls.some(c => c.url.includes('pi_hold/cancel')));
});

test('daily run: a declined card unconfirms the booking and tells both people', async () => {
  const mails = [];
  const calls = fakeWorld([base({ id: 'd', holdStatus: 'saved', startsAt: new Date(Date.now() + 30 * HOUR).toISOString(), stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_declined', holdAmountCents: 6000 })]);
  const out = await H.runHolds({ mail: async (k, r) => mails.push([k, r.id]) });
  assert.equal(out.cardFailed, 1);
  const p = patches(calls).find(x => x.holdStatus === 'failed');
  assert.equal(p.paid, false); assert.equal(p.stripeSessionId, null);
  assert.deepEqual(mails, [['card-failed', 'd']]);
});
