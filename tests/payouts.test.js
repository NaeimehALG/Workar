const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.SUPABASE_URL = 'https://example.test';
const P = require('../api/_payouts');

const H = 3600 * 1000;
const base = { id: 'r1', mentorId: 'm1', clientId: 'c1', paid: true, amountCents: 4900, status: 'accepted', packageKey: 'single', startsAt: new Date(Date.now() - 50 * H).toISOString(), stripeChargeId: 'ch_1', payoutCents: 3430 };

test('payouts wait 48 hours after the session and for every session of a package', () => {
  assert.equal(P.isReleasable(base), true);
  assert.equal(P.isReleasable({ ...base, startsAt: new Date(Date.now() - 10 * H).toISOString() }), false);
  assert.equal(P.isReleasable({ ...base, packageKey: 'interview', sessionsDone: 2 }), false);
  assert.equal(P.isReleasable({ ...base, packageKey: 'interview', sessionsDone: 3 }), true);
  assert.equal(P.isReleasable({ ...base, payoutDone: true }), false);
  assert.equal(P.isReleasable({ ...base, stripeTransferId: 'tr_1' }), false);
  assert.equal(P.isReleasable({ ...base, status: 'cancelled' }), false);
  assert.equal(P.isReleasable({ ...base, paid: false }), false);
});

function mockWorld({ account = { mentorId: 'm1', stripeAccountId: 'acct_1', payoutsEnabled: true }, charge = {}, requests = [base] } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    let data = [];
    if (url.includes('/site_settings')) data = [{ data: { mentorShare: 70 } }];
    else if (url.includes('/requests?') && (opts.method || 'GET') === 'GET') data = requests;
    else if (url.includes('/mentor_payout_accounts')) data = account ? [account] : [];
    else if (url.includes('api.stripe.com/v1/charges/')) data = Object.assign({ id: 'ch_1', amount: 4900, currency: 'usd', balance_transaction: { currency: 'cad', amount: 6700 } }, charge);
    else if (url.includes('api.stripe.com/v1/transfers')) data = { id: 'tr_1' };
    else if (url.includes('api.stripe.com/v1/accounts/')) data = { payouts_enabled: false, capabilities: {}, requirements: { currently_due: ['external_account'] } };
    return { ok: true, status: 200, json: async () => data };
  };
  return calls;
}

test('a finished session is paid to the mentor in the settlement currency, once', async () => {
  const calls = mockWorld();
  const mails = [];
  const out = await P.releaseDue({ sendMail: async (k) => mails.push(k) });
  assert.equal(out.paidOut, 1);
  const tr = calls.find(c => c.url.endsWith('/v1/transfers'));
  const body = new URLSearchParams(tr.opts.body);
  assert.equal(body.get('destination'), 'acct_1');
  assert.equal(body.get('source_transaction'), 'ch_1');
  assert.equal(body.get('currency'), 'cad');
  assert.equal(body.get('amount'), String(Math.floor(6700 * 3430 / 4900)));
  assert.equal(tr.opts.headers['Idempotency-Key'], 'workar-payout-r1');
  const saved = calls.find(c => c.opts.method === 'PATCH' && c.opts.body.includes('tr_1'));
  assert.ok(saved && JSON.parse(saved.opts.body).payoutDone === true);
  assert.deepEqual(mails, ['paid']);
});

test('refunded or disputed bookings are held, not paid', async () => {
  for (const charge of [{ refunded: true }, { amount_refunded: 1000 }, { disputed: true }]) {
    const calls = mockWorld({ charge });
    const out = await P.releaseDue({});
    assert.equal(out.paidOut, 0);
    assert.equal(out.problems.length, 1);
    assert.equal(calls.some(c => c.url.endsWith('/v1/transfers')), false);
  }
});

test('mentors without bank details get one email and their money waits', async () => {
  const calls = mockWorld({ account: null });
  const mails = [];
  const out = await P.releaseDue({ sendMail: async (k) => mails.push(k) });
  assert.equal(out.paidOut, 0);
  assert.equal(out.waitingForBank.length, 1);
  assert.deepEqual(mails, ['bank-needed']);
  assert.ok(calls.some(c => c.opts.method === 'PATCH' && c.opts.body.includes('payoutNudgedAt')));
  assert.equal(calls.some(c => c.url.endsWith('/v1/transfers')), false);

  const mails2 = [];
  mockWorld({ account: null, requests: [{ ...base, payoutNudgedAt: new Date().toISOString() }] });
  await P.releaseDue({ sendMail: async (k) => mails2.push(k) });
  assert.deepEqual(mails2, []);
});

test('the share is locked in when the client pays', async () => {
  const calls = mockWorld();
  global.fetch = (orig => async (url, opts) => url.includes('payment_intents') ? { ok: true, json: async () => ({ latest_charge: 'ch_9' }) } : orig(url, opts))(global.fetch);
  const upd = await P.recordPayment('r1', { amount_total: 4900, payment_intent: 'pi_1' });
  assert.deepEqual(upd, { payoutCents: 3430, stripeChargeId: 'ch_9' });
  assert.ok(calls.length >= 1);
});
