// Vercel Serverless Function: creates a Stripe Checkout Session. Handles three kinds of purchase:
//   kind: "booking"    — a client paying to confirm an accepted mentorship request (default)
//   kind: "ai_credits" — a user buying a pack of AI coaching credits
//   kind: "exam"       — a PMP Prep mock exam or the all-access pass
// Keeps your Stripe secret key server-side. Set STRIPE_SECRET_KEY as an Environment
// Variable in your Vercel project settings.

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
  const { kind, requestId, amountCents, mentorName, userId, successUrl, cancelUrl } = body || {};

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY is not set on the server' });
    return;
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
    if (!userId || !examId) { res.status(400).json({ error: 'missing-params' }); return; }
    if (!supabaseUrl || !serviceKey) { res.status(500).json({ error: 'server-not-configured' }); return; }
    const h = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
    let priceUsd = 0, title = 'Workar PMP Prep';
    try {
      if (examId === 'all') {
        const st = await (await fetch(`${supabaseUrl}/rest/v1/site_settings?id=eq.main&select=data`, { headers: h })).json();
        const d = (Array.isArray(st) && st[0] && st[0].data) || {};
        priceUsd = Number(d.prepBundlePrice) || DEFAULT_PREP_BUNDLE_PRICE;
        title = 'Workar PMP Prep — All-Access Pass';
      } else {
        const ex = await (await fetch(`${supabaseUrl}/rest/v1/exams?id=eq.${encodeURIComponent(examId)}&select=*`, { headers: h })).json();
        const row = Array.isArray(ex) ? ex[0] : null;
        if (!row || row.isFree) { res.status(400).json({ error: 'exam-not-for-sale' }); return; }
        priceUsd = Number(row.priceUsd) || 0;
        title = `Workar PMP Prep — ${row.title}`;
      }
    } catch (e) {
      res.status(500).json({ error: 'price-lookup-failed' }); return;
    }
    const cents = Math.round(priceUsd * 100);
    if (cents < 50) { res.status(400).json({ error: 'invalid-price' }); return; }
    params.append('client_reference_id', userId);
    params.append('metadata[kind]', 'exam');
    params.append('metadata[userId]', userId);
    params.append('metadata[examId]', examId);
    params.append('line_items[0][price_data][unit_amount]', String(cents));
    params.append('line_items[0][price_data][product_data][name]', title);
  } else if (kind === 'ai_credits') {
    if (!userId) {
      res.status(400).json({ error: 'missing-user-id' });
      return;
    }
    params.append('client_reference_id', userId);
    params.append('metadata[kind]', 'ai_credits');
    params.append('metadata[userId]', userId);
    params.append('metadata[credits]', String(AI_CREDIT_PACK_CREDITS));
    params.append('line_items[0][price_data][unit_amount]', String(AI_CREDIT_PACK_PRICE_CENTS));
    params.append('line_items[0][price_data][product_data][name]',
      `${AI_CREDIT_PACK_CREDITS} AI coaching messages`);
  } else {
    // Price is decided server-side from the booking's package + the admin's site settings,
    // so the amount can't be changed in the browser.
    let amount =
