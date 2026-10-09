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
  single:    { price: 49, sessions: 1 },
  resume:    { price: 89 },
  interview: { price: 129 },
  offer:     { price: 249 }
};

const DEFAULT_PREP_BUNDLE_PRICE = 24.99;

module.exports = async (req, res) => {
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
  if (kind && !['booking', 'exam', 'ai_credits'].includes(kind)) return res.status(400).json({ error: 'invalid-purchase-kind' });
  const allowed = new Set(['https://workar.me', 'https://www.workar.me']);
  try { if (process.env.SITE_URL) allowed.add(new URL(process.env.SITE_URL).origin); } catch (e) {}
  for (const value of [successUrl, cancelUrl]) {
    try { const u = new URL(value); if (!allowed.has(u.origin) || u.username || u.password) throw new Error(); }
    catch (e) { return res.status(400).json({ error: 'invalid-return-url' }); }
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl || '');
  params.append('cancel_url', cancelUrl || '');
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', 'usd');

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
    let amount = 0;
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
        const st = await readRows(`${supabaseUrl}/rest/v1/site_settings?id=eq.main&select=data`, h);
        const saved = (Array.isArray(st) && st[0] && st[0].data && Array.isArray(st[0].data.packages)) ? st[0].data.packages : [];
        const key = reqRow.packageKey || 'single';
        const pkg = Object.assign({}, DEFAULT_PACKAGES[key] || DEFAULT_PACKAGES.single, saved.find(x => x.key === key) || {});
        // Mentors set their own rate (never below the Workar minimum = single-session price);
        // package prices scale with that rate.
        const single = Object.assign({}, DEFAULT_PACKAGES.single, saved.find(x => x.key === 'single') || {});
        const minRate = Math.round(Number(single.price) / (Number(single.sessions) || 1)) || 49;
        let rate = minRate;
        if (reqRow.mentorId) {
          const pr = await readRows(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(reqRow.mentorId)}&select=sessionRate`, h);
          const r = Array.isArray(pr) && pr[0] ? Number(pr[0].sessionRate) : 0;
          if (r > minRate) rate = Math.round(r);
        }
        amount = Math.round(Number(pkg.price) * rate / minRate) * 100;
      } catch (e) {
        res.status(503).json({ error: 'price-lookup-failed' }); return;
      }
    }
    if (!requestId || !Number.isSafeInteger(amount) || amount < 50) {
      // Stripe requires at least ~$0.50 for a USD charge.
      res.status(400).json({ error: 'missing-or-invalid-params' });
      return;
    }
    params.append('client_reference_id', requestId);
    params.append('metadata[kind]', 'booking');
    params.append('metadata[requestId]', requestId);
    params.append('line_items[0][price_data][unit_amount]', String(amount));
    params.append('line_items[0][price_data][product_data][name]',
      `Workar mentoring with ${mentorName || 'your mentor'}`);
  }

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = String((data && data.error && data.error.message) || '');
      // A Stripe account that hasn't finished activation can't take real payments yet
      const code = /cannot currently make live charges|activate|account.*(not|isn't).*(enabled|active)/i.test(msg) ? 'payments-not-activated' : 'stripe-error';
      console.error('stripe-checkout-failed', msg);
      res.status(502).json({ error: code, detail: data && data.error });
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
