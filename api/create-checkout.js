process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Serverless Function: creates a Stripe Checkout Session. Handles three kinds of purchase:
//   kind: "booking"    — a client paying to confirm an accepted mentorship request (default)
//   kind: "ai_credits" — a user buying a pack of AI coaching credits
//   kind: "exam"       — a PMP Prep mock exam or the all-access pass
// Keeps your Stripe secret key server-side. Set STRIPE_SECRET_KEY as an Environment
// Variable in your Vercel project settings.

const { userFromToken } = require('./_mail');

async function readRows(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error('price-lookup-failed');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('price-lookup-failed');
  return rows;
}

const AI_CREDIT_PACK_CREDITS = 20;
const AI_CREDIT_PACK_PRICE_CENTS = 499; // $4.99 — fixed server-side so it can't be tampered with

// Must match DEFAULT_PACKAGES in index.html (used when the admin hasn't saved custom prices)
const DEFAULT_PACKAGES = {
  single:    { price: 30, sessions: 1 },
  resume:    { price: 55 },
  interview: { price: 79 },
  offer:     { price: 150 }
};

const DEFAULT_PREP_BUNDLE_PRICE = 24.99;

// GET /api/create-checkout (also /payment-status) → payment setup health, for the admin only:
// the admin's own sign-in token, or "Authorization: Bearer <CRON_SECRET>". No secrets are returned, and
// nothing is ever created on Stripe from here.
const ADMIN_EMAIL = () => String(process.env.ADMIN_EMAIL || 'naeimeh.alaghehband@gmail.com').toLowerCase();
async function healthAllowed(req) {
  const token = String((req.headers || {}).authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const cron = process.env.CRON_SECRET;
  if (cron && cron.length >= 16 && token === cron) return true;
  try { const me = await userFromToken(token); return !!(me && !me.is_anonymous && String(me.email || '').toLowerCase() === ADMIN_EMAIL()); }
  catch (e) { return false; }
}
async function health(res) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const out = { mode: key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : (key ? 'test' : 'missing'), webhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET };
  const E = process.env; // which services are configured (true/false only, never the values)
  out.services = { database: !!E.SUPABASE_SERVICE_ROLE_KEY, email: !!E.RESEND_API_KEY, ai: !!E.ANTHROPIC_API_KEY, voice: !!E.OPENAI_API_KEY, cron: !!E.CRON_SECRET, video: E.DAILY_API_KEY ? 'daily' : 'jitsi' };
  // Video: confirm the Daily key is accepted (a read-only call; no room is created).
  if (E.DAILY_API_KEY) {
    try { const d = await fetch('https://api.daily.co/v1/', { headers: { Authorization: 'Bearer ' + E.DAILY_API_KEY } }); out.videoKeyWorks = d.ok; if (!d.ok) out.videoKeyStatus = d.status; }
    catch (e) { out.videoKeyWorks = null; }
  }
  if (key) {
    // Read-only checks; the account id and name are not returned.
    const get = async path => { const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + key } }); return { ok: r.ok, body: await r.json().catch(() => ({})) }; };
    try { const a = await get('account'); out.chargesEnabled = a.ok ? !!a.body.charges_enabled : null; if (a.ok && a.body.requirements) out.disabledReason = a.body.requirements.disabled_reason || null; } catch (e) { out.chargesEnabled = null; }
    try { const c = await get('accounts?limit=1'); out.connect = c.ok; if (!c.ok) console.error('health-connect', String((c.body.error && c.body.error.message) || '').slice(0, 200)); } catch (e) { out.connect = null; }
  }
  res.status(200).json(out);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (!(await healthAllowed(req))) { res.status(401).json({ error: 'admin-only' }); return; }
    return health(res);
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { kind, requestId, mentorName, userId, successUrl, cancelUrl } = body || {};

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY is not set on the server' });
    return;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'server-not-configured' });
  let me;
  try { me = await userFromToken(String((req.headers || {}).authorization || '').replace(/^Bearer\s+/i, '')); }
  catch (e) { return res.status(503).json({ error: 'authentication-unavailable' }); }
  if (!me || !me.id) return res.status(401).json({ error: 'sign-in-required' });
  if (userId && userId !== me.id) return res.status(403).json({ error: 'not-your-account' });
  if (kind === 'confirm') {
    // Bookings are paid on the mentor's own Stripe account; check the session and mark the booking paid
    try {
      const rq = await readRows(`${process.env.SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(requestId || '')}&select=clientId,mentorId`, { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY });
      const row = rq[0];
      if (!row) return res.status(404).json({ error: 'request-not-found' });
      if (row.clientId !== me.id && row.mentorId !== me.id) return res.status(403).json({ error: 'not-your-booking' });
      return res.status(200).json(await require('./_payouts').confirmPayment(requestId));
    } catch (e) { console.error('confirm-failed', e.message); return res.status(502).json({ error: 'confirm-failed' }); }
  }
  if (kind && !['booking', 'exam', 'ai_credits'].includes(kind)) return res.status(400).json({ error: 'invalid-purchase-kind' });
  const allowed = new Set(['https://workar.me', 'https://www.workar.me']);
  try { if (process.env.SITE_URL) allowed.add(new URL(process.env.SITE_URL).origin); } catch (e) {}
  for (const value of [successUrl, cancelUrl]) {
    try { const u = new URL(value); if (!allowed.has(u.origin) || u.username || u.password) throw new Error(); }
    catch (e) { return res.status(400).json({ error: 'invalid-return-url' }); }
  }

  const params = new URLSearchParams();
  let saveSession = false; // bookings: remember the Checkout Session so payment can be confirmed without the webhook
  params.append('mode', 'payment');
  params.append('success_url', successUrl || '');
  params.append('cancel_url', cancelUrl || '');
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', 'cad'); // Workar charges in Canadian dollars

  if (kind === 'exam') {
    // PMP Prep: price is looked up server-side (exams table, or the all-access pass in site settings)
    const { examId } = body || {};
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!examId) { res.status(400).json({ error: 'missing-params' }); return; }
    if (!supabaseUrl || !serviceKey) { res.status(500).json({ error: 'server-not-configured' }); return; }
    const h = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
    let priceUsd = 0, title = 'Workar PMP Prep';
    try {
      if (examId === 'all') {
        const st = await readRows(`${supabaseUrl}/rest/v1/site_settings?id=eq.main&select=data`, h);
        const d = (Array.isArray(st) && st[0] && st[0].data) || {};
        priceUsd = Number(d.prepBundlePrice) || DEFAULT_PREP_BUNDLE_PRICE;
        title = 'Workar PMP Prep — All-Access Pass';
      } else {
        const ex = await readRows(`${supabaseUrl}/rest/v1/exams?id=eq.${encodeURIComponent(examId)}&select=*`, h);
        const row = Array.isArray(ex) ? ex[0] : null;
        if (!row || row.isFree) { res.status(400).json({ error: 'exam-not-for-sale' }); return; }
        priceUsd = Number(row.priceUsd) || 0;
        title = `Workar PMP Prep — ${row.title}`;
      }
    } catch (e) {
      res.status(500).json({ error: 'price-lookup-failed' }); return;
    }
    const cents = Math.round(priceUsd * 100);
    if (!Number.isSafeInteger(cents) || cents < 50) { res.status(400).json({ error: 'invalid-price' }); return; }
    params.append('client_reference_id', me.id);
    params.append('metadata[kind]', 'exam');
    params.append('metadata[userId]', me.id);
    params.append('metadata[examId]', examId);
    params.append('line_items[0][price_data][unit_amount]', String(cents));
    params.append('line_items[0][price_data][product_data][name]', title);
  } else if (kind === 'ai_credits') {
    if (!me.id) {
      res.status(400).json({ error: 'missing-user-id' });
      return;
    }
    params.append('client_reference_id', me.id);
    params.append('metadata[kind]', 'ai_credits');
    params.append('metadata[userId]', me.id);
    params.append('metadata[credits]', String(AI_CREDIT_PACK_CREDITS));
    params.append('line_items[0][price_data][unit_amount]', String(AI_CREDIT_PACK_PRICE_CENTS));
    params.append('line_items[0][price_data][product_data][name]',
      `${AI_CREDIT_PACK_CREDITS} AI coaching messages`);
  } else {
    // Price is decided server-side from the booking's package + the admin's site settings,
    // so the amount can't be changed in the browser.
    let amount = 0, startsAt = null;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && serviceKey && requestId) {
      try {
        const h = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
        const rq = await readRows(`${supabaseUrl}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}&select=*`, h);
        const reqRow = Array.isArray(rq) ? rq[0] : null;
        if (!reqRow) { res.status(404).json({ error: 'request-not-found' }); return; }
        if (reqRow.clientId !== me.id) { res.status(403).json({ error: 'not-your-booking' }); return; }
        if (reqRow.status !== 'accepted') { res.status(409).json({ error: 'booking-not-accepted' }); return; }
        if (reqRow.paid) { res.status(400).json({ error: 'already-paid' }); return; }
        startsAt = reqRow.startsAt || null;
        const st = await readRows(`${supabaseUrl}/rest/v1/site_settings?id=eq.main&select=data`, h);
        const saved = (Array.isArray(st) && st[0] && st[0].data && Array.isArray(st[0].data.packages)) ? st[0].data.packages : [];
        const key = reqRow.packageKey || 'single';
        const pkg = Object.assign({}, DEFAULT_PACKAGES[key] || DEFAULT_PACKAGES.single, saved.find(x => x.key === key) || {});
        // Mentors set their own rate (never below the Workar minimum = single-session price);
        // package prices scale with that rate.
        const single = Object.assign({}, DEFAULT_PACKAGES.single, saved.find(x => x.key === 'single') || {});
        const minRate = Math.round(Number(single.price) / (Number(single.sessions) || 1)) || 30;
        let rate = minRate;
        if (reqRow.mentorId) {
          const pr = await readRows(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(reqRow.mentorId)}&select=sessionRate`, h);
          const r = Array.isArray(pr) && pr[0] ? Number(pr[0].sessionRate) : 0;
          if (r > minRate) rate = Math.round(r);
        }
        amount = Math.round(Number(pkg.price) * rate / minRate) * 100;
        // The database sets the booking's price when it is made (supabase-booking-protection.sql), so charge
        // that saved price: the client pays what they saw, even if the mentor changes their rate afterwards.
        const savedCents = Number(reqRow.amountCents);
        // Only for bookings made after that database rule went live; older prices were set in the browser.
        const PRICE_RULE_SINCE = Date.parse('2026-10-24T17:30:00Z');
        const madeAt = Date.parse(reqRow.created_at || '') || 0; // set by the database, not the browser
        if (madeAt >= PRICE_RULE_SINCE && Number.isSafeInteger(savedCents) && savedCents >= 50) amount = savedCents;
      } catch (e) {
        res.status(503).json({ error: 'price-lookup-failed' }); return;
      }
    }
    if (!requestId || !Number.isSafeInteger(amount) || amount < 50) {
      // Stripe requires at least ~$0.50 per charge.
      res.status(400).json({ error: 'missing-or-invalid-params' });
      return;
    }
    // TaskRabbit-style: the card is held, not charged. It is charged only after the session happens,
    // and released if the session doesn't happen (api/_holds.js runs the rest every day).
    const H = require('./_holds');
    let customer;
    try { customer = await H.customerFor(me); }
    catch (e) { console.error('customer-failed', e.message); res.status(502).json({ error: 'stripe-error' }); return; }
    const holdNow = H.holdNowAtCheckout(startsAt);
    const price = '$' + (amount / 100).toFixed(2) + ' CAD';
    params.set('success_url', String(successUrl || '') + (String(successUrl || '').includes('?') ? '&' : '?') + 'cs={CHECKOUT_SESSION_ID}');
    params.append('client_reference_id', requestId);
    params.append('customer', customer);
    params.append('payment_method_types[0]', 'card');
    params.append('metadata[kind]', 'booking');
    params.append('metadata[requestId]', requestId);
    params.append('metadata[amountCents]', String(amount));
    params.append('metadata[holdMode]', holdNow ? 'now' : 'later');
    if (holdNow) {
      params.append('payment_intent_data[capture_method]', 'manual');
      params.append('payment_intent_data[setup_future_usage]', 'off_session'); // lets Workar hold it again if the session moves
      params.append('payment_intent_data[metadata][requestId]', requestId);
      params.append('payment_intent_data[description]', `Workar mentoring with ${mentorName || 'your mentor'}`);
      params.append('line_items[0][price_data][unit_amount]', String(amount));
      params.append('line_items[0][price_data][product_data][name]', `Workar mentoring with ${mentorName || 'your mentor'}`);
      params.append('custom_text[submit][message]', `This is a hold on your card, not a charge. You are charged ${price} only after your session takes place. If your mentor cancels or doesn't show up, the hold is released and you pay nothing.`);
    } else {
      // Setup mode: save the card only. Stripe holds can't last until a session this far away.
      params.set('mode', 'setup');
      ['line_items[0][quantity]', 'line_items[0][price_data][currency]'].forEach(k => params.delete(k));
      params.append('setup_intent_data[metadata][requestId]', requestId);
      params.append('setup_intent_data[description]', `Workar mentoring with ${mentorName || 'your mentor'} — ${price}`);
      params.append('custom_text[submit][message]', `Nothing is charged today. Two days before your session we place a hold of ${price} on this card, and charge it only after your session takes place. If your mentor cancels or doesn't show up, you pay nothing.`);
    }
    saveSession = true;
  }

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: Object.assign({
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      }),
      body: params.toString()
    });
    const data = await r.json();
    if (r.ok && saveSession && requestId) {
      // remember the session so the booking can be confirmed even if the client closes the tab
      // (only while unpaid: a checkout from a second tab must not replace the session that was already paid)
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}&paid=is.false`, { method: 'PATCH',
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ stripeSessionId: data.id }) }).catch(e => console.error('session-save-failed', e.message));
    }
    if (!r.ok) {
      const msg = String((data && data.error && data.error.message) || '');
      // A Stripe account that hasn't finished activation can't take real payments yet
      const code = /cannot currently make live charges|activate|account.*(not|isn't).*(enabled|active)/i.test(msg) ? 'payments-not-activated' : 'stripe-error';
      console.error('stripe-checkout-failed', r.status, data && data.error && data.error.type, msg);
      res.status(502).json({ error: code }); // Stripe's own message stays in the server log
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (e) {
    console.error('checkout-failed', e && e.message);
    res.status(500).json({ error: 'checkout-failed' });
  }
};
