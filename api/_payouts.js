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

const HOLD_HOURS = (Number(process.env.PAYOUT_HOLD_DAYS) || 7) * 24; // like Airbnb/Turo: Workar holds the payment, then pays the mentor
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
async function stripe(method, path, params, idempotencyKey, stripeAccount) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw Object.assign(new Error('STRIPE_SECRET_KEY is not set'), { code: 'not-configured' });
  const headers = { Authorization: 'Bearer ' + key };
  if (stripeAccount) headers['Stripe-Account'] = stripeAccount;
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

// Stripe Accounts v2 (new Connect integrations must create connected accounts here)
const STRIPE_V2_VERSION = () => process.env.STRIPE_V2_VERSION || '2026-09-30.endive';
async function stripeV2(method, path, body, idempotencyKey) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw Object.assign(new Error('STRIPE_SECRET_KEY is not set'), { code: 'not-configured' });
  const headers = { Authorization: 'Bearer ' + key, 'Stripe-Version': STRIPE_V2_VERSION() };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const r = await fetch('https://api.stripe.com/v2/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = data && data.error;
    const err = new Error((e && e.message) || ('stripe-error ' + r.status));
    err.code = e && e.code; err.stripe = true;
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
// The mentor's share percentage is locked on the booking the first time it is paid (or held), so changing
// the commission later never changes past bookings.
async function lockedSharePct(requestId) {
  try {
    const row = (await dbRows(`requests?id=eq.${encodeURIComponent(requestId)}&select=mentorSharePct`))[0];
    const v = Number(row && row.mentorSharePct);
    if (v > 0 && v <= 100) return { pct: v, saved: true };
  } catch (e) {}
  return { pct: await mentorSharePct(), saved: false };
}
// Set once, by the server, when a booking becomes paid: locks the mentor's share and clears any money
// bookkeeping a client could have put on the row before paying.
async function paymentLockFields() {
  return { mentorSharePct: await mentorSharePct(), sessionLog: null, payoutSessions: null, payoutClaimAt: null,
    sessionsKept: null, cancelAlertAt: null, problemSession: null }; // holdAttempt is kept: Stripe keys must never repeat
}
async function recordPayment(requestId, session) {
  const amount = Number(session.amount_total) || 0;
  const { pct: share, saved } = await lockedSharePct(requestId);
  const upd = { payoutCents: Math.round(amount * share / 100) };
  if (session.payment_intent) {
    try {
      const pi = await stripe('GET', 'payment_intents/' + encodeURIComponent(session.payment_intent));
      if (pi.latest_charge) upd.stripeChargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id;
    } catch (e) { console.error('charge-lookup-failed', requestId, e.message); } // found again later by releaseDue
  }
  await dbPatch(`requests?id=eq.${encodeURIComponent(requestId)}&stripeTransferId=is.null`, saved ? upd : Object.assign({ mentorSharePct: share }, upd));
  return upd;
}

// ---------- mentor bank setup ----------
async function accountRow(mentorId) {
  const rows = await dbRows(`mentor_payout_accounts?mentorId=eq.${encodeURIComponent(mentorId)}&select=*`);
  return rows[0] || null;
}
// Like accountRow, but forgets a saved account the current Stripe key can't see
// (e.g. one made with the sandbox key before Workar switched to live), so the mentor can start fresh.
const MISSING = e => !!(e && e.stripe && (e.code === 'resource_missing' || e.code === 'account_invalid' || /no such account|does not exist|not have access to account|not connected to your platform/i.test(e.message || '')));
async function usableAccountRow(mentorId) {
  const row = await accountRow(mentorId);
  if (!row) return null;
  try { await stripe('GET', 'accounts/' + encodeURIComponent(row.stripeAccountId)); return row; }
  catch (e) {
    if (!MISSING(e)) throw e;
    console.warn('payout-account-forgotten', mentorId, row.stripeAccountId, e.message);
    const r = await fetch(`${SB()}/rest/v1/mentor_payout_accounts?mentorId=eq.${encodeURIComponent(mentorId)}`, { method: 'DELETE', headers: Object.assign({ Prefer: 'return=minimal' }, svc()) });
    if (!r.ok) throw new Error('database-write-failed ' + r.status);
    return null;
  }
}

function isReady(acct) {
  return !!(acct && acct.payouts_enabled && acct.capabilities && acct.capabilities.transfers === 'active');
}
// Workar pays mentors by transfer: their account must be able to receive transfers and pay out to the bank
function isReadyV2(a) {
  const sb = a && a.configuration && a.configuration.recipient && a.configuration.recipient.capabilities && a.configuration.recipient.capabilities.stripe_balance;
  const ok = c => c && c.status === 'active';
  return !!(sb && ok(sb.stripe_transfers) && (!sb.payouts || ok(sb.payouts)));
}

async function refreshStatus(row) {
  let enabled, needsInfo;
  try {
    const a = await stripeV2('GET', `core/accounts/${encodeURIComponent(row.stripeAccountId)}?include=configuration.recipient`);
    enabled = isReadyV2(a);
    needsInfo = !enabled;
  } catch (e) {
    const acct = await stripe('GET', 'accounts/' + encodeURIComponent(row.stripeAccountId));
    enabled = isReady(acct);
    const due = (acct.requirements && acct.requirements.currently_due) || [];
    needsInfo = !enabled && (due.length > 0 || !acct.details_submitted);
  }
  if (enabled !== !!row.payoutsEnabled) {
    await dbPatch(`mentor_payout_accounts?mentorId=eq.${encodeURIComponent(row.mentorId)}`, { payoutsEnabled: enabled, updatedAt: new Date().toISOString() });
  }
  return { connected: true, enabled, needsInfo };
}

async function createAccount({ mentorId, email, country, name }) {
  // Accounts v2 "recipient" with the Express dashboard: receives Workar's transfers after each session
  const acct = await stripeV2('POST', 'core/accounts', {
    contact_email: email || undefined,
    display_name: name || undefined,
    dashboard: 'express',
    identity: { country: String(country).toLowerCase(), entity_type: 'individual' },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    metadata: { workarUserId: mentorId },
    include: ['configuration.recipient', 'identity']
  }, 'workar-acct-recipient-' + mentorId + '-' + country);
  await dbInsert('mentor_payout_accounts', { mentorId, stripeAccountId: acct.id, country, payoutsEnabled: false });
  return acct.id;
}

async function onboardingLink(stripeAccountId, site) {
  try {
    const link = await stripeV2('POST', 'core/account_links', {
      account: stripeAccountId,
      use_case: { type: 'account_onboarding', account_onboarding: { refresh_url: site + '/?payouts=refresh', return_url: site + '/?payouts=done' } }
    });
    return link.url;
  } catch (e) {
    const link = await stripe('POST', 'account_links', { account: stripeAccountId, type: 'account_onboarding', refresh_url: site + '/?payouts=refresh', return_url: site + '/?payouts=done' });
    return link.url;
  }
}

// Express dashboard: the mentor's payout history and bank details
async function dashboardLink(stripeAccountId) {
  const link = await stripe('POST', `accounts/${encodeURIComponent(stripeAccountId)}/login_links`, {});
  return link.url;
}

// ---------- confirm a paid booking by checking its Checkout Session (backup for the webhook) ----------
async function confirmPayment(requestId) {
  const r = (await dbRows(`requests?id=eq.${encodeURIComponent(requestId)}&select=*`))[0];
  if (!r) return { error: 'request-not-found' };
  if (r.paid) return { paid: true, already: true };
  if (!r.stripeSessionId) return { paid: false };
  const session = await stripe('GET', 'checkout/sessions/' + encodeURIComponent(r.stripeSessionId));
  // card-hold bookings: the card is held or saved, and charged only after the session (api/_holds.js)
  if (session.metadata && session.metadata.holdMode) return require('./_holds').secureFromSession(requestId, session);
  if (session.payment_status !== 'paid') return { paid: false };
  await dbPatch(`requests?id=eq.${encodeURIComponent(requestId)}&paid=is.false`, Object.assign(await paymentLockFields(), { paid: true }));
  try { await recordPayment(requestId, session); } catch (e) { console.error('payout-record-failed', e.message); }
  try { await require('./_session').confirmPaidSession(requestId); } catch (e) { console.error('session-confirm-failed', e); }
  return { paid: true };
}

// ---------- step 3: the daily release ----------
// Each session is paid separately: the mentor gets (sessions done / sessions in the package) of their share,
// for sessions that are done, older than HOLD_HOURS, and (where Daily keeps a record) attended by both people.
function sessionsIn(r) { return Math.max(1, Number(r.sessions) || PKG_SESSIONS[r.packageKey] || 1); }
const BAD_ATTENDANCE = ['mentor-absent', 'none'];
const SESSION_MIN = () => Number(process.env.SESSION_MINUTES) || 30;

// The booking's sessions, one entry per session number. Entries come from requests.sessionLog (added by the
// database each time the mentor marks a session done). Older bookings without a log: a single session counts
// once its time has passed; a package counts only when every session was marked done (the old rule).
function sessionList(r) {
  const total = sessionsIn(r);
  const log = Array.isArray(r.sessionLog) ? r.sessionLog.filter(e => e && Number(e.n) >= 1) : [];
  if (!log.length) {
    if (total === 1 && r.startsAt) return [{ n: 1, startsAt: r.startsAt, implicit: true }];
    if (total > 1 && (Number(r.sessionsDone) || 0) >= total && r.startsAt) return Array.from({ length: total }, (_, i) => ({ n: i + 1, startsAt: r.startsAt, att: { status: 'legacy' } }));
    return [];
  }
  const byN = {};
  for (const e of log) { const k = Number(e.n); if (!byN[k] || (!entryOk(r, byN[k], false) && entryOk(r, e, false))) byN[k] = e; }
  // a package session counts only while it is still marked done (the admin may undo a wrong mark)
  const marked = total > 1 ? (Number(r.sessionsDone) || 0) : total;
  // The database logs every session a mentor marks. A marked session without an entry (e.g. marked by the admin)
  // is checked against Daily like any other; if that flags it, the admin's "Release payout" approves it.
  if (total > 1) for (let k = 1; k <= Math.min(marked, total); k++) if (!byN[k]) byN[k] = { n: k, startsAt: r.lastDoneStartsAt || r.startsAt };
  return Object.keys(byN).map(Number).filter(n => n <= total && n <= marked).sort((a, b) => a - b).map(n => byN[n]);
}
// May this session be paid / counted as used? Unchecked entries count only when assumeUnchecked.
function entryOk(r, e, assumeUnchecked) {
  if (e.adminOk) return true;
  if (!e.att) return !!assumeUnchecked;
  if (!BAD_ATTENDANCE.includes(e.att.status)) return true;
  // the admin chose "Release payout" after this session's attendance was checked
  const res = r.problemResolvedAt ? Date.parse(r.problemResolvedAt) : NaN, at = e.att.at ? Date.parse(e.att.at) : NaN;
  return r.status !== 'refunded' && Number.isFinite(res) && Number.isFinite(at) && res > at;
}
// Sessions the client used (for refunding only the unused part of a package)
function usedSessions(r) { return Math.min(sessionsIn(r), sessionList(r).filter(e => entryOk(r, e, true)).length); }
function keptSessions(r) { const t = sessionsIn(r); return r.sessionsKept != null && Number.isFinite(Number(r.sessionsKept)) ? Math.max(0, Math.min(t, Number(r.sessionsKept))) : t; }
// Sessions that can be paid to the mentor now
function payableSessions(r, now = Date.now(), assumeUnchecked = true) {
  const n = sessionList(r).filter(e => {
    const t = Date.parse(e.startsAt);
    return Number.isFinite(t) && now - t >= HOLD_HOURS * 3600 * 1000 && entryOk(r, e, assumeUnchecked);
  }).length;
  return Math.min(n, keptSessions(r));
}
// Sessions already paid to the mentor (older bookings paid in one transfer: all of them)
function paidSessions(r) {
  if (r.payoutSessions != null && Number.isFinite(Number(r.payoutSessions))) return Number(r.payoutSessions);
  return (r.payoutDone || r.stripeTransferId) ? sessionsIn(r) : 0;
}
// The share percentage locked on the booking (older bookings: derived from the locked payoutCents)
function sharePctOf(r, fallback = DEFAULT_MENTOR_SHARE) {
  const v = Number(r.mentorSharePct);
  if (v > 0 && v <= 100) return v;
  const a = Number(r.amountCents), p = Number(r.payoutCents);
  if (r.payoutCents != null && a > 0 && p >= 0 && !(r.sessionsKept != null)) return p * 100 / a;
  return fallback;
}
// The mentor's total for the first n sessions, in booking (CAD) cents
function mentorCentsFor(r, n, fallbackPct) {
  const total = sessionsIn(r);
  const k = Math.max(0, Math.min(n, total));
  return Math.floor(Math.round(Number(r.amountCents) * sharePctOf(r, fallbackPct)) * k / (100 * total));
}

// Late client cancellation: measured against the start time the booking was paid/held for.
// (The client can't move the start of a paid booking except by accepting a time the mentor suggested — protect_request.)
function lateClientCancel(r) {
  if (r.status !== 'cancelled' || !r.cancelledBy || r.cancelledBy !== r.clientId) return false;
  const st = Date.parse(r.startsAt), c = Date.parse(r.cancelledAt);
  return Number.isFinite(st) && Number.isFinite(c) && st - c < 24 * 3600 * 1000;
}

// A booking is ready to pay out once a session is safely in the past and not yet paid.
function isReleasable(r, now = Date.now()) {
  if (!r.paid || r.payoutDone || !(Number(r.amountCents) > 0)) return false;
  if (r.payoutSessions == null && r.stripeTransferId) return false; // paid in one transfer (older bookings)
  const partialRefund = r.status === 'refunded' && r.holdStatus === 'refunded' && Number(r.sessionsKept) > 0;
  if (r.status === 'refunded' && !partialRefund) return false;
  if (['cancelled', 'declined'].includes(r.status)) {
    if (r.holdStatus !== 'captured') return false;
    // a cancelled booking that was charged is paid only for a late cancellation by the client
    // (no cancelledBy recorded = older booking: unchanged)
    if (r.cancelledBy && !lateClientCancel(r)) return false;
    if (r.status === 'declined') return false;
  }
  // card-hold bookings pay out only once the client's card has actually been charged
  if (r.holdStatus && r.holdStatus !== 'captured' && !partialRefund) return false;
  if (r.problemReportedAt && !r.problemResolvedAt) return false; // the client reported a problem: wait for the admin
  if (lateClientCancel(r)) { // the client cancelled late: the charge stands for the sessions kept
    const st = Date.parse(r.startsAt);
    return Number.isFinite(st) && now - st >= HOLD_HOURS * 3600 * 1000 && paidSessions(r) < keptSessions(r);
  }
  return payableSessions(r, now) > paidSessions(r);
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

// Does the Stripe charge still hold the money this booking keeps? A refund of unused package sessions
// (or the uncaptured rest of a partial capture) is expected; anything beyond that, or a dispute, is not.
function chargeCovers(r, charge) {
  if (!charge || charge.disputed) return false;
  const refunded = Number(charge.amount_refunded) || 0;
  if (r.sessionsKept == null || !Number.isFinite(Number(r.sessionsKept))) return !charge.refunded && refunded === 0;
  const keep = keptSessions(r);
  if (keep <= 0) return false;
  const need = Math.floor(Number(r.amountCents) * keep / sessionsIn(r));
  return Number(charge.amount) - refunded >= need - 1; // 1 cent of rounding
}

// ---------- money alerts for the admin's daily digest ----------
// agent_events row: id "money_alert:<key>", kind "money_alert", ref = short plain text. Returns true the first time.
async function moneyAlert(key, text) {
  try {
    const r = await fetch(`${SB()}/rest/v1/agent_events?on_conflict=id`, {
      method: 'POST', headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=representation' }, svc()),
      body: JSON.stringify({ id: 'money_alert:' + String(key).slice(0, 200), kind: 'money_alert', ref: String(text).slice(0, 500), createdAt: new Date().toISOString() })
    });
    if (!r.ok) { console.error('money-alert-failed', r.status); return true; }
    const rows = await r.json().catch(() => null);
    return !Array.isArray(rows) || rows.length > 0;
  } catch (e) { console.error('money-alert-failed', e.message); return true; }
}

// ---------- attendance evidence per session (Daily) ----------
// Reads Daily attendance for sessions that ended and were not checked yet, saves it in sessionLog, and
// returns the updated booking plus lines for the admin. Never blocks money when Daily has no record.
async function verifySessions(r, problems = [], now = Date.now()) {
  const MT = require('./_meeting');
  const list = sessionList(r);
  const due = list.filter(e => !e.att && Number.isFinite(Date.parse(e.startsAt)) && now - Date.parse(e.startsAt) > (SESSION_MIN() + 30) * 60000);
  // the admin chose "Release payout" after a session was flagged: remember it on that session for good
  // (a later report on another session clears problemResolvedAt)
  const approve = list.filter(e => e.att && !e.adminOk && BAD_ATTENDANCE.includes(e.att.status) && entryOk(r, e, false));
  if (!due.length && !approve.length) return r;
  let names = null;
  const log = Array.isArray(r.sessionLog) ? r.sessionLog.map(e => Object.assign({}, e)) : [];
  for (const e of approve) { const i = log.findIndex(x => Number(x.n) === Number(e.n) && x.att && x.att.at === e.att.at); if (i >= 0) log[i].adminOk = new Date(now).toISOString(); }
  for (const e of due) {
    if (!names && MT.isDaily(r.meetingUrl) && process.env.DAILY_API_KEY) {
      const M = require('./_mail');
      const [m, c] = await Promise.all([M.profile(r.mentorId), M.profile(r.clientId)]);
      names = { mentor: m && m.name, client: c && c.name };
    }
    const a = await MT.sessionAttendance(r, e.startsAt, names || {});
    const att = { status: a.status, note: String(a.note || '').slice(0, 200), at: new Date(now).toISOString() };
    const label = `session ${e.n} of booking ${r.id}`;
    if (BAD_ATTENDANCE.includes(a.status)) problems.push(`Daily shows the mentor did not attend ${label} (${att.note}). That session is not paid to the mentor. If it did take place, choose "Release payout" for it in Admin → Mentor payouts.`);
    else if (a.status === 'unavailable' && MT.isDaily(r.meetingUrl)) problems.push(`Attendance for ${label} could not be checked (${att.note}). It is paid as usual; please check it if anything looks wrong.`);
    else if (a.status === 'unclear' || a.status === 'client-absent') problems.push(`Attendance for ${label} needs a look: ${a.status === 'client-absent' ? 'the client did not join' : 'the names in the call did not match'} (${att.note}). It is paid as usual.`);
    const i = log.findIndex(x => Number(x.n) === Number(e.n) && !x.att);
    if (i >= 0) log[i].att = att; else log.push(Object.assign({}, e, { att }));
  }
  const guard = r.sessionsDone == null ? 'sessionsDone=is.null' : 'sessionsDone=eq.' + Number(r.sessionsDone);
  try { await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}&${guard}`, { sessionLog: log }); }
  catch (e) { console.error('session-log-save-failed', r.id, e.message); }
  return Object.assign({}, r, { sessionLog: log });
}

// ---------- double-payout protection ----------
// 1) Claim the booking in the database before calling Stripe (only one run at a time; a stale claim expires).
const CLAIM_MINUTES = 30;
async function claimPayout(id, now = Date.now()) {
  const stale = new Date(now - CLAIM_MINUTES * 60000).toISOString();
  const cond = `(or(payoutDone.is.null,payoutDone.eq.false),or(payoutClaimAt.is.null,payoutClaimAt.lt."${stale}"))`;
  const r = await fetch(`${SB()}/rest/v1/requests?id=eq.${encodeURIComponent(id)}&and=${encodeURIComponent(cond)}&select=id`, {
    method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation,count=exact' }, svc()), body: JSON.stringify({ payoutClaimAt: new Date(now).toISOString() })
  });
  if (!r.ok) throw new Error('database-write-failed ' + r.status);
  // PostgREST reports how many rows the guarded update changed in Content-Range ("0-0/1" or "*/0")
  const cr = r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-range') : null;
  const m = cr ? /\/(\d+)$/.exec(cr) : null;
  if (m) return Number(m[1]) > 0; // 0: another run holds the claim (or it was paid meanwhile)
  return true; // no count available: rely on the Stripe transfer check that follows
}
async function unclaim(id) { try { await dbPatch(`requests?id=eq.${encodeURIComponent(id)}`, { payoutClaimAt: null }); } catch (e) {} }
// 2) Ask Stripe what was already transferred for this booking (survives a lost database update).
async function stripePaidSessions(r) {
  const res = await stripe('GET', 'transfers', { transfer_group: 'booking_' + r.id, limit: 100 });
  const list = (res && Array.isArray(res.data) ? res.data : []).filter(t => !t.metadata || !t.metadata.requestId || t.metadata.requestId === r.id);
  let upTo = 0, last = null;
  for (const t of list) {
    const n = t.metadata && t.metadata.sessionsUpTo != null ? Number(t.metadata.sessionsUpTo) : sessionsIn(r); // older single transfer = everything
    if (n > upTo) { upTo = n; last = t.id; }
  }
  return { upTo, last, transfers: list };
}

async function releaseDue({ sendMail } = {}) {
  const out = { paidOut: 0, paidOutCents: 0, waitingForBank: [], problems: [] };
  if (!process.env.STRIPE_SECRET_KEY) return out;
  const share = await mentorSharePct();
  const list = (await dbRows('requests?paid=eq.true&or=(payoutDone.is.null,payoutDone.eq.false)&select=*'))
    .filter(r => isReleasable(r)).slice(0, MAX_PER_RUN);
  const accounts = {};
  for (let r of list) {
    const label = `booking ${r.id}`;
    let claimed = false;
    try {
      const late = lateClientCancel(r);
      const kept = keptSessions(r);
      if (!(r.mentorId in accounts)) {
        const row = await accountRow(r.mentorId);
        accounts[r.mentorId] = row && !row.payoutsEnabled ? Object.assign(row, { payoutsEnabled: (await refreshStatus(row)).enabled }) : row;
      }
      const acct = accounts[r.mentorId];
      if (!acct || !acct.payoutsEnabled) {
        const n = late ? kept : payableSessions(r);
        const cents = mentorCentsFor(r, n, share) - mentorCentsFor(r, paidSessions(r), share);
        out.waitingForBank.push({ requestId: r.id, mentorId: r.mentorId, cents });
        if (!r.payoutNudgedAt && sendMail) {
          await sendMail('bank-needed', r, cents);
          await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { payoutNudgedAt: new Date().toISOString() });
        }
        continue;
      }
      if (!(await claimPayout(r.id))) continue; // another run is paying this booking right now
      claimed = true;
      if (!late) r = await verifySessions(r, out.problems);
      const n = late ? kept : payableSessions(r, Date.now(), false);
      let base = paidSessions(r);
      if (n <= base) { await unclaim(r.id); continue; }
      // What did Stripe already send? If a previous run paid but couldn't save it, record that and stop.
      const sp = await stripePaidSessions(r);
      if (sp.upTo > base) base = sp.upTo;
      if (n <= base) {
        await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { stripeTransferId: sp.last, payoutSessions: base, payoutDone: base >= kept, payoutClaimAt: null, payoutError: null });
        out.problems.push(`Payout for ${label} was already sent in Stripe (${sp.last}) but not saved; Workar recorded it now and did not pay again.`);
        continue;
      }
      const chargeId = await chargeFor(r);
      if (!chargeId) throw new Error('no Stripe charge found for this booking');
      const charge = await stripe('GET', 'charges/' + encodeURIComponent(chargeId), { expand: ['balance_transaction'] });
      if (!chargeCovers(r, charge)) {
        const why = charge.disputed ? 'the client disputed the payment' : 'the payment was refunded';
        if (r.payoutError !== why) await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { payoutError: why });
        out.problems.push(`Payout held for ${label}: ${why}. Check it in the admin panel.`);
        await unclaim(r.id);
        continue;
      }
      const mentorCents = mentorCentsFor(r, n, share) - mentorCentsFor(r, base, share);
      // Pay in the currency the money actually settled in (a USD charge may settle as CAD).
      const bt = charge.balance_transaction && typeof charge.balance_transaction === 'object' ? charge.balance_transaction : null;
      const currency = (bt && bt.currency) || charge.currency;
      const amount = bt && bt.currency !== charge.currency
        ? Math.floor(Number(bt.amount) * mentorCents / Number(charge.amount))
        : mentorCents;
      if (!(amount > 0)) throw new Error('payout amount is zero');
      const total = sessionsIn(r);
      const key = base === 0 && n >= total ? 'workar-payout-' + r.id : `workar-payout-${r.id}-s${base}-${n}`;
      const tr = await stripe('POST', 'transfers', {
        amount, currency,
        destination: acct.stripeAccountId,
        source_transaction: chargeId,
        transfer_group: 'booking_' + r.id,
        description: total > 1 ? `Workar mentoring payout (sessions ${base + 1}-${n} of ${total})` : 'Workar mentoring payout',
        metadata: { requestId: r.id, mentorId: r.mentorId, sessionsUpTo: n, sessionsTotal: total }
      }, key);
      await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, {
        stripeTransferId: tr.id, payoutSessions: n, payoutDone: n >= kept, payoutAt: new Date().toISOString(), payoutError: null, payoutClaimAt: null
      });
      claimed = false;
      out.paidOut++; out.paidOutCents += mentorCents;
      if (sendMail) { try { await sendMail('paid', r, mentorCents); } catch (e) { console.error('payout-email-failed', r.id, e.message); } }
    } catch (e) {
      console.error('payout-failed', r.id, e.message);
      // keep the claim on a failure after Stripe may have been called: the next run checks Stripe first anyway
      try { await dbPatch(`requests?id=eq.${encodeURIComponent(r.id)}`, { payoutError: String(e.message || e).slice(0, 300) }); } catch (x) {}
      out.problems.push(`Payout failed for ${label}: ${e.message || e}`);
    }
    if (claimed) { /* left in place on purpose; it expires after CLAIM_MINUTES */ }
  }
  return out;
}

// ---------- reversing a mentor's transfer (dispute / refund) ----------
// Takes money back from the mentor so they keep only `keepFraction` (0..1) of each transfer for this booking.
// Safe to repeat: it looks at what was already reversed, and each reversal has its own idempotency key.
async function reverseTransfers(r, keepFraction, reason) {
  const sp = await stripePaidSessions(r);
  const keep = Math.min(1, Math.max(0, Number(keepFraction) || 0));
  let reversed = 0;
  for (const t of sp.transfers) {
    const left = Number(t.amount) - Number(t.amount_reversed || 0);
    const target = Number(t.amount) - Math.floor(Number(t.amount) * keep); // total that should be reversed
    const want = Math.min(left, target - Number(t.amount_reversed || 0));
    if (!(want > 0)) continue;
    await stripe('POST', `transfers/${encodeURIComponent(t.id)}/reversals`, { amount: want, metadata: { requestId: r.id, reason: String(reason).slice(0, 100) } }, `workar-reverse-${t.id}-${String(reason).slice(0, 60)}-${target}`);
    reversed += want;
  }
  return reversed;
}

module.exports = {
  HOLD_HOURS, DEFAULT_MENTOR_SHARE, BAD_ATTENDANCE, stripe, form, mentorSharePct, recordPayment,
  accountRow, usableAccountRow, refreshStatus, createAccount, onboardingLink, dashboardLink, confirmPayment, isReady, isReleasable, releaseDue,
  sessionsIn, sessionList, usedSessions, keptSessions, payableSessions, paidSessions, sharePctOf, mentorCentsFor, lateClientCancel,
  chargeCovers, paymentLockFields, moneyAlert, verifySessions, claimPayout, stripePaidSessions, reverseTransfers
};
