// Vercel Serverless Function: creates a Stripe Checkout Session. Handles two kinds of purchase:
//   kind: "booking"    — a client paying to confirm an accepted mentorship request (default)
//   kind: "ai_credits" — a user buying a pack of AI coaching credits
// Keeps your Stripe secret key server-side. Set STRIPE_SECRET_KEY as an Environment
// Variable in your Vercel project settings.

const AI_CREDIT_PACK_CREDITS = 20;
const AI_CREDIT_PACK_PRICE_CENTS = 499; // $4.99 — fixed server-side so it can't be tampered with

// Must match DEFAULT_PACKAGES in index.html (used when the admin hasn't saved custom prices)
const DEFAULT_PACKAGES = {
  single:    { price: 49 },
  resume:    { price: 89 },
  interview: { price: 129 },
  offer:     { price: 249 }
};

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

  if (kind === 'ai_credits') {
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
    let amount = Math.round(Number(amountCents));
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && serviceKey && requestId) {
      try {
        const h = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
        const rq = await (await fetch(`${supabaseUrl}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}&select=*`, { headers: h })).json();
        const reqRow = Array.isArray(rq) ? rq[0] : null;
        if (!reqRow) { res.status(404).json({ error: 'request-not-found' }); return; }
        if (reqRow.paid) { res.status(400).json({ error: 'already-paid' }); return; }
        const st = await (await fetch(`${supabaseUrl}/rest/v1/site_settings?id=eq.main&select=data`, { headers: h })).json();
        const saved = (Array.isArray(st) && st[0] && st[0].data && Array.isArray(st[0].data.packages)) ? st[0].data.packages : [];
        const key = reqRow.packageKey || 'single';
        const pkg = Object.assign({}, DEFAULT_PACKAGES[key] || DEFAULT_PACKAGES.single, saved.find(x => x.key === key) || {});
        amount = Math.round(Number(pkg.price) * 100);
      } catch (e) {
        // fall back to the amount stored on the request
      }
    }
    if (!requestId || !amount || amount < 50) {
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
      res.status(502).json({ error: 'stripe-error', detail: data && data.error });
      return;
    }
    res.status(200).json({ url: data.url });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
