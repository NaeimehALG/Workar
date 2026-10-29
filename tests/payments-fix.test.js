// Oct 29 2026 money fixes: double payouts, per-session package payouts, attendance, holds, webhooks.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.SUPABASE_URL = 'https://example.test';
const P = require('../api/_payouts');
const H = require('../api/_holds');
const MT = require('../api/_meeting');

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const ago = ms => new Date(Date.now() - ms).toISOString();
const sec = iso => Math.floor(Date.parse(iso) / 1000);

// ---------- a fake world: Supabase + Stripe + Daily ----------
function world({ requests = [], transfers = [], claim = 1, daily = null, pis = [], piGet = null, charge = {} } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body || '';
    calls.push({ url, method, body, headers: opts.headers || {} });
    const j = (data, extra = {}) => Object.assign({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data), headers: { get: () => null } }, extra);
    if (url.includes('api.daily.co')) return daily ? j({ data: daily }) : j({ error: 'x' }, { ok: false, status: 500 });
    if (url.includes('/rest/v1/profiles')) return j([{ id: 'x', name: url.includes('m1') ? 'Mia Mentor' : 'Cal Client' }]);
    if (url.includes('/rest/v1/site_settings')) return j([{ data: { mentorShare: 80 } }]);
    if (url.includes('/rest/v1/mentor_payout_accounts')) return j([{ mentorId: 'm1', stripeAccountId: 'acct_1', payoutsEnabled: true }]);
    if (url.includes('/rest/v1/agent_events')) return j([{ id: 'money_alert:x' }]);
    if (url.includes('/rest/v1/requests') && method === 'GET') return j(requests);
    if (url.includes('/rest/v1/requests') && method === 'PATCH') {
      if (url.includes('payoutClaimAt')) return j(claim ? [{ id: 'r1' }] : [], { headers: { get: k => (k === 'content-range' ? (claim ? '0-0/1' : '*/0') : null) } });
      return j([Object.assign({ id: 'r1' }, JSON.parse(body))]);
    }
    if (url.includes('api.stripe.com/v1/transfers') && url.includes('/reversals')) return j({ id: 'trr_1' });
    if (url.includes('api.stripe.com/v1/transfers') && method === 'GET') return j({ data: transfers });
    if (url.includes('api.stripe.com/v1/transfers') && method === 'POST') return j({ id: 'tr_new' });
    if (url.includes('api.stripe.com/v1/charges/')) return j(Object.assign({ id: 'ch_1', amount: 15000, currency: 'cad', amount_refunded: 0, balance_transaction: { currency: 'cad', amount: 15000 } }, charge));
    if (/payment_intents\?/.test(url) && method === 'GET') return j({ data: pis });
    if (url.endsWith('/payment_intents') && method === 'POST') return j({ id: 'pi_new', status: 'requires_capture', amount: 6000, latest_charge: { id: 'ch_2' } });
    if (/payment_intents\/pi_\w+\/capture/.test(url)) return j({ id: 'pi_hold', status: 'succeeded', amount: 15000, amount_received: 5000, latest_charge: { id: 'ch_1' } });
    if (/payment_intents\/pi_\w+\/cancel/.test(url)) return j({ id: 'pi_hold', status: 'canceled' });
    if (/payment_intents\/pi_\w+/.test(url)) return j(piGet || { id: 'pi_new', status: 'requires_capture', amount: 6000, latest_charge: { id: 'ch_2' } });
    if (url.includes('api.stripe.com/v1/refunds')) return j({ id: 're_1' });
    return j({});
  };
  return calls;
}
const transferBodies = calls => calls.filter(c => c.method === 'POST' && /\/v1\/transfers$/.test(c.url)).map(c => new URLSearchParams(c.body));
const patches = calls => calls.filter(c => c.method === 'PATCH' && c.url.includes('/requests')).map(c => JSON.parse(c.body));

// a 6-session package (CA$150, mentor share locked at 70%)
const pkg = (o = {}) => Object.assign({ id: 'r1', mentorId: 'm1', clientId: 'c1', paid: true, status: 'accepted', packageKey: 'offer', amountCents: 15000,
  mentorSharePct: 70, holdStatus: 'captured', stripeChargeId: 'ch_1', stripePaymentIntentId: 'pi_hold', startsAt: ago(DAY) }, o);
const ok = (n, t) => ({ n, startsAt: t, att: { status: 'both', at: ago(0) } });

test('a package is paid per session: only sessions done, older than the hold period, with attendance', () => {
  const r = pkg({ sessionsDone: 3, sessionLog: [ok(1, ago(9 * DAY)), ok(2, ago(8 * DAY)), ok(3, ago(2 * DAY))] });
  assert.equal(P.payableSessions(r), 2);
  assert.equal(P.isReleasable(r), true);
  assert.equal(P.isReleasable(Object.assign({}, r, { payoutSessions: 2 })), false); // nothing new yet
  assert.equal(P.mentorCentsFor(r, 2), Math.floor(10500 * 2 / 6));                 // 70% of CA$150, 2 of 6 sessions
  // a session where Daily shows the mentor never joined is not paid ...
  const absent = pkg({ sessionsDone: 2, sessionLog: [ok(1, ago(9 * DAY)), { n: 2, startsAt: ago(8 * DAY), att: { status: 'mentor-absent', at: ago(7 * DAY) } }] });
  assert.equal(P.payableSessions(absent), 1);
  // ... until the admin releases it
  assert.equal(P.payableSessions(Object.assign({}, absent, { problemResolvedAt: ago(DAY) })), 2);
  // marking sessions done without them in the log (old data) never pays a package early
  assert.equal(P.payableSessions(pkg({ sessionsDone: 2 })), 0);
  // unmarking a session (admin) removes it
  assert.equal(P.payableSessions(Object.assign({}, r, { sessionsDone: 1 })), 1);
});

test('the share percentage saved on the booking is used, not today\'s setting', () => {
  assert.equal(P.sharePctOf({ mentorSharePct: 65, amountCents: 1000 }), 65);
  assert.equal(P.sharePctOf({ amountCents: 4000, payoutCents: 2800 }), 70); // older booking: from the locked payoutCents
  assert.equal(P.mentorCentsFor({ amountCents: 4000, mentorSharePct: 70, packageKey: 'single' }, 1, 80), 2800);
});

test('daily run pays the difference for new sessions, with metadata and a per-range idempotency key', async () => {
  const r = pkg({ sessionsDone: 3, payoutSessions: 1, stripeTransferId: 'tr_old', sessionLog: [ok(1, ago(9 * DAY)), ok(2, ago(8 * DAY)), ok(3, ago(8 * DAY))] });
  const calls = world({ requests: [r], transfers: [{ id: 'tr_old', amount: 1750, metadata: { requestId: 'r1', sessionsUpTo: '1' } }] });
  const out = await P.releaseDue({});
  assert.equal(out.paidOut, 1, out.problems.join('\n'));
  const [b] = transferBodies(calls);
  assert.equal(b.get('amount'), String(Math.floor(10500 * 3 / 6) - Math.floor(10500 / 6)));
  assert.equal(b.get('metadata[sessionsUpTo]'), '3');
  assert.equal(b.get('transfer_group'), 'booking_r1');
  const tr = calls.find(c => /\/v1\/transfers$/.test(c.url) && c.method === 'POST');
  assert.equal(tr.headers['Idempotency-Key'], 'workar-payout-r1-s1-3');
  const saved = patches(calls).find(p => p.stripeTransferId === 'tr_new');
  assert.equal(saved.payoutSessions, 3); assert.equal(saved.payoutDone, false);
  // the claim comes before Stripe is called
  const iClaim = calls.findIndex(c => c.method === 'PATCH' && c.url.includes('payoutClaimAt'));
  const iTransfer = calls.findIndex(c => c.method === 'POST' && /\/v1\/transfers$/.test(c.url));
  assert.ok(iClaim >= 0 && iClaim < iTransfer);
});

test('no double payout: a transfer Stripe already made is recorded, not repeated', async () => {
  const r = { id: 'r1', mentorId: 'm1', clientId: 'c1', paid: true, status: 'accepted', packageKey: 'single', amountCents: 4000, payoutCents: 2800, stripeChargeId: 'ch_1', startsAt: ago(9 * DAY), sessionLog: [ok(1, ago(9 * DAY))] };
  const calls = world({ requests: [r], transfers: [{ id: 'tr_lost', amount: 2800, metadata: { requestId: 'r1' } }] });
  const out = await P.releaseDue({});
  assert.equal(out.paidOut, 0);
  assert.equal(transferBodies(calls).length, 0);
  const saved = patches(calls).find(p => p.stripeTransferId === 'tr_lost');
  assert.ok(saved && saved.payoutDone === true);
  assert.match(out.problems.join(' '), /already sent in Stripe/);
});

test('no double payout: a booking another run has claimed is skipped', async () => {
  const r = { id: 'r1', mentorId: 'm1', clientId: 'c1', paid: true, status: 'accepted', packageKey: 'single', amountCents: 4000, payoutCents: 2800, stripeChargeId: 'ch_1', startsAt: ago(9 * DAY), sessionLog: [ok(1, ago(9 * DAY))] };
  const calls = world({ requests: [r], claim: 0 });
  const out = await P.releaseDue({});
  assert.equal(out.paidOut, 0);
  assert.equal(calls.some(c => c.url.includes('api.stripe.com/v1/transfers')), false);
});

test('a session is checked against Daily before it is paid; a no-show mentor is not paid and the admin is told', async () => {
  const start = ago(8 * DAY);
  const r = { id: 'r1', mentorId: 'm1', clientId: 'c1', paid: true, status: 'accepted', packageKey: 'single', amountCents: 4000, mentorSharePct: 70, stripeChargeId: 'ch_1', startsAt: start, meetingUrl: 'https://workar.daily.co/room1', meetingRoom: 'room1' };
  process.env.DAILY_API_KEY = 'dk';
  try {
    const calls = world({ requests: [r], daily: [{ participants: [{ user_name: 'Cal Client', join_time: sec(start) + 60, duration: 1500 }] }] });
    const out = await P.releaseDue({});
    assert.equal(out.paidOut, 0);
    assert.equal(transferBodies(calls).length, 0);
    assert.match(out.problems.join(' '), /mentor did not attend session 1/);
    const log = patches(calls).find(p => p.sessionLog).sessionLog;
    assert.equal(log[0].att.status, 'mentor-absent');
    // both joined → paid
    const calls2 = world({ requests: [r], daily: [{ participants: [{ user_name: 'Cal Client', join_time: sec(start), duration: 1700 }, { user_name: 'Mia Mentor', join_time: sec(start), duration: 1700 }] }] });
    const out2 = await P.releaseDue({});
    assert.equal(out2.paidOut, 1, out2.problems.join('\n'));
    assert.equal(transferBodies(calls2)[0].get('amount'), '2800');
  } finally { delete process.env.DAILY_API_KEY; }
});

test('Daily attendance is classified per session; no record never blocks', async () => {
  const s = Date.parse('2026-10-20T15:00:00Z');
  const p = (name, mins, off = 0) => ({ user_name: name, join_time: s / 1000 + off, duration: mins * 60 });
  const names = { mentor: 'Mia', client: 'Cal' };
  assert.equal(MT.classifyAttendance([{ participants: [p('Mia', 28), p('Cal', 29)] }], names, s).status, 'both');
  assert.equal(MT.classifyAttendance([{ participants: [p('Cal', 29)] }], names, s).status, 'mentor-absent');
  assert.equal(MT.classifyAttendance([{ participants: [p('Mia', 2), p('Cal', 29)] }], names, s).status, 'mentor-absent'); // 2 minutes isn't attending
  assert.equal(MT.classifyAttendance([], names, s).status, 'none');
  assert.equal(MT.classifyAttendance([{ participants: [p('Guest', 28), p('Cal', 29)] }], names, s).status, 'unclear');
  // a call from another session of the package (a week earlier) doesn't count for this one
  assert.equal(MT.classifyAttendance([{ participants: [p('Mia', 28, -7 * 86400), p('Cal', 29)] }], names, s).status, 'mentor-absent');
  assert.equal((await MT.sessionAttendance({ meetingUrl: 'https://meet.jit.si/x' }, null, names)).status, 'unavailable');
});

test('cancelled after the charge: no payout unless the client cancelled late; the admin is alerted once', () => {
  const base = { id: 'r1', mentorId: 'm', clientId: 'c', paid: true, amountCents: 3000, holdStatus: 'captured', status: 'cancelled', startsAt: ago(10 * DAY), payoutCents: 2100, sessionLog: [ok(1, ago(10 * DAY))] };
  assert.equal(P.isReleasable(Object.assign({}, base, { cancelledBy: 'm', cancelledAt: ago(11 * DAY) })), false);              // mentor cancelled
  assert.equal(P.isReleasable(Object.assign({}, base, { cancelledBy: 'c', cancelledAt: ago(12 * DAY) })), false);              // client, in time
  assert.equal(P.isReleasable(Object.assign({}, base, { cancelledBy: 'c', cancelledAt: ago(10 * DAY + 2 * HOUR) })), true);   // client, late
  assert.equal(H.decide(Object.assign({}, base, { cancelledBy: 'm', cancelledAt: ago(HOUR) })), 'alert-cancelled');
  assert.equal(H.decide(Object.assign({}, base, { cancelledBy: 'm', cancelledAt: ago(HOUR), cancelAlertAt: ago(0) })), 'none');
});

test('"Don\'t charge" on a package charges only the sessions used; a single session is released', () => {
  const r = pkg({ holdStatus: 'authorized', status: 'refunded', sessionsDone: 2, problemSession: 3, holdAmountCents: 15000, sessionLog: [ok(1, ago(9 * DAY)), ok(2, ago(8 * DAY))] });
  assert.equal(H.keepFor(r), 2);
  assert.equal(H.decide(r), 'capture');
  assert.equal(H.decide(Object.assign({}, r, { sessionsDone: 0, sessionLog: null })), 'release');
  assert.equal(H.keepFor({ packageKey: 'single', status: 'refunded' }), 0);
  // the report was about session 2: session 2 is not kept even though it was marked done
  assert.equal(H.keepFor(Object.assign({}, r, { problemSession: 2 })), 1);
});

test('partial capture charges the used sessions and pays out for them', async () => {
  const r = pkg({ holdStatus: 'authorized', status: 'refunded', sessionsDone: 2, problemSession: 3, holdAmountCents: 15000, sessionLog: [ok(1, ago(9 * DAY)), ok(2, ago(8 * DAY))], problemReportedAt: ago(DAY), problemResolvedAt: ago(0) });
  const calls = world({ requests: [r] });
  await H.capture(r);
  const cap = calls.find(c => c.url.includes('/capture'));
  assert.equal(new URLSearchParams(cap.body).get('amount_to_capture'), '5000');
  const ps = patches(calls);
  assert.equal(ps[0].sessionsKept, 2);
  assert.ok(ps.some(p => p.holdStatus === 'refunded'));
  // payouts continue for the 2 kept sessions
  const after = Object.assign({}, r, { holdStatus: 'refunded', sessionsKept: 2 });
  assert.equal(P.isReleasable(after), true);
  assert.equal(P.chargeCovers(after, { amount: 15000, amount_refunded: 10000 }), true);  // uncaptured rest: expected
  assert.equal(P.chargeCovers(after, { amount: 15000, amount_refunded: 12000 }), false); // more than that: hold the payout
  assert.equal(P.chargeCovers({ amountCents: 4000 }, { amount: 4000, amount_refunded: 0, disputed: true }), false);
});

test('refund of a captured package returns only the unused sessions and takes back an overpaid transfer', async () => {
  const r = pkg({ status: 'refunded', sessionsDone: 1, problemSession: 2, payoutSessions: 2, stripeTransferId: 'tr_1', sessionLog: [ok(1, ago(9 * DAY)), ok(2, ago(8 * DAY))] });
  const calls = world({ requests: [r], piGet: { id: 'pi_hold', status: 'succeeded', amount: 15000, latest_charge: { id: 'ch_1', amount: 15000, amount_refunded: 0 } },
    transfers: [{ id: 'tr_1', amount: 3500, amount_reversed: 0, metadata: { requestId: 'r1', sessionsUpTo: '2' } }] });
  await H.refund(r);
  const rf = calls.find(c => c.url.endsWith('/v1/refunds'));
  assert.equal(new URLSearchParams(rf.body).get('amount'), String(15000 - 2500)); // keeps 1 of 6 sessions
  const rev = calls.find(c => c.url.includes('/reversals'));
  assert.equal(new URLSearchParams(rev.body).get('amount'), String(3500 - Math.floor(3500 * (1750 / 3500))));
  assert.ok(patches(calls).some(p => p.payoutSessions === 1 && p.payoutDone === true));
});

test('holds: a crash-left PaymentIntent for the same attempt is reused, not created again', async () => {
  const r = { id: 'r1', clientId: 'c', mentorId: 'm', status: 'accepted', paid: true, amountCents: 6000, holdAmountCents: 6000, holdStatus: 'saved', stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1', holdAttempt: 2, startsAt: new Date(Date.now() + 30 * HOUR).toISOString() };
  const calls = world({ pis: [{ id: 'pi_left', status: 'requires_capture', amount: 6000, metadata: { requestId: 'r1', attempt: '2', holdKind: 'auth' }, latest_charge: { id: 'ch_9' } }] });
  assert.equal(await H.authorize(r), 'authorized');
  assert.equal(calls.some(c => c.url.endsWith('/payment_intents') && c.method === 'POST'), false);
  assert.equal(patches(calls)[0].stripePaymentIntentId, 'pi_left');
});

test('holds: each attempt has its own idempotency key and the status is re-read after create', async () => {
  const r = { id: 'r1', clientId: 'c', mentorId: 'm', status: 'accepted', paid: true, amountCents: 6000, holdAmountCents: 6000, holdStatus: 'saved', stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1', holdAttempt: 3 };
  // the create answer says requires_capture, but the PaymentIntent is canceled by now: must not be recorded as held
  const calls = world({ piGet: { id: 'pi_new', status: 'canceled', amount: 6000 } });
  await assert.rejects(H.authorize(r), /could not be held \(canceled\)/);
  const post = calls.find(c => c.url.endsWith('/payment_intents') && c.method === 'POST');
  assert.equal(post.headers['Idempotency-Key'], 'workar-hold-r1-auth-a3-pm_1');
  assert.equal(new URLSearchParams(post.body).get('metadata[attempt]'), '3');
  // re-holding moves to the next attempt
  const calls2 = world();
  await H.rehold({ id: 'r1', stripePaymentIntentId: 'pi_hold', holdStatus: 'authorized', holdAttempt: 3 });
  assert.equal(patches(calls2)[0].holdAttempt, 4);
});

test('holds: the client is not charged when Daily shows the mentor never joined', async () => {
  const start = new Date(Date.now() - 30 * HOUR).toISOString();
  const r = { id: 'r1', clientId: 'c1', mentorId: 'm1', status: 'accepted', paid: true, amountCents: 4000, holdStatus: 'authorized', stripePaymentIntentId: 'pi_hold', startsAt: start,
    holdCaptureBefore: new Date(Date.now() + 3 * DAY).toISOString(), meetingUrl: 'https://workar.daily.co/room1', meetingRoom: 'room1' };
  process.env.DAILY_API_KEY = 'dk';
  try {
    const calls = world({ requests: [r], daily: [{ participants: [{ user_name: 'Cal Client', join_time: sec(start), duration: 1200 }] }] });
    const out = await H.runHolds({});
    assert.equal(out.charged, 0);
    assert.equal(calls.some(c => c.url.includes('/capture')), false);
    assert.match(out.problems.join(' '), /NOT charged/);
    // the client confirming the session overrides the check
    const calls2 = world({ requests: [Object.assign({}, r, { clientConfirmedAt: start })] });
    const out2 = await H.runHolds({});
    assert.equal(out2.charged, 1);
    assert.ok(calls2.some(c => c.url.includes('/capture')));
  } finally { delete process.env.DAILY_API_KEY; }
});

test('webhook: a dispute takes back the mentor transfer and leaves a money_alert for the digest', async () => {
  const W = require('../api/stripe-webhook');
  const r = { id: 'r1', mentorId: 'm1', clientId: 'c1', packageKey: 'single', amountCents: 4000, stripePaymentIntentId: 'pi_1', stripeChargeId: 'ch_1', payoutDone: true, stripeTransferId: 'tr_1' };
  const calls = world({ requests: [r], transfers: [{ id: 'tr_1', amount: 2800, amount_reversed: 0, metadata: { requestId: 'r1' } }] });
  const h = { apikey: 'svc', Authorization: 'Bearer svc', 'Content-Type': 'application/json' };
  const what = await W.handleMoneyEvent({ id: 'evt_1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', charge: 'ch_1', payment_intent: 'pi_1', amount: 4000, reason: 'fraudulent' } } }, 'https://example.test', h);
  assert.equal(what, 'dispute');
  assert.equal(new URLSearchParams(calls.find(c => c.url.includes('/reversals')).body).get('amount'), '2800');
  const alert = calls.find(c => c.url.includes('agent_events'));
  const row = JSON.parse(alert.body);
  assert.equal(row.kind, 'money_alert'); assert.equal(row.id, 'money_alert:evt:evt_1'); assert.match(row.ref, /Dispute opened on booking r1/);
  assert.ok(patches(calls).some(p => p.payoutError === 'the client disputed the payment'));
});

test('webhook: Workar\'s own refunds are ignored; other refunds and expired holds alert the admin', async () => {
  const W = require('../api/stripe-webhook');
  const h = {};
  const own = { id: 'r1', mentorId: 'm1', clientId: 'c1', packageKey: 'single', amountCents: 4000, status: 'refunded', sessionsKept: 0, stripePaymentIntentId: 'pi_1' };
  let calls = world({ requests: [own] });
  assert.equal(await W.handleMoneyEvent({ id: 'e1', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 4000, amount_refunded: 4000 } } }, 'https://example.test', h), 'refund-own');
  assert.equal(calls.some(c => c.url.includes('agent_events')), false);
  const other = { id: 'r1', mentorId: 'm1', clientId: 'c1', packageKey: 'single', amountCents: 4000, status: 'accepted', stripePaymentIntentId: 'pi_1', holdStatus: 'captured' };
  calls = world({ requests: [other] });
  assert.equal(await W.handleMoneyEvent({ id: 'e2', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 4000, amount_refunded: 4000 } } }, 'https://example.test', h), 'refund');
  assert.ok(patches(calls).some(p => p.holdStatus === 'refunded'));
  assert.ok(calls.some(c => c.url.includes('agent_events')));
  calls = world({ requests: [{ id: 'r1', holdStatus: 'authorized', stripePaymentIntentId: 'pi_1' }] });
  assert.equal(await W.handleMoneyEvent({ id: 'e3', type: 'payment_intent.canceled', data: { object: { id: 'pi_1', cancellation_reason: 'automatic', amount: 4000 } } }, 'https://example.test', h), 'hold-cancelled');
  assert.ok(patches(calls).some(p => p.holdStatus === 'expired'));
  calls = world({ requests: [] });
  assert.equal(await W.handleMoneyEvent({ id: 'e4', type: 'payment_intent.canceled', data: { object: { id: 'pi_1', cancellation_reason: 'abandoned' } } }, 'https://example.test', h), 'cancel-own');
});
