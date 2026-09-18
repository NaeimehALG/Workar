// Vercel Serverless Function: creates a Stripe Checkout Session so a client can pay to
// confirm an accepted mentorship request. Keeps your Stripe secret key server-side.
// Set STRIPE_SECRET_KEY as an Environment Variable in your Vercel project settings.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { requestId, amountCents, mentorName, successUrl, cancelUrl } = body || {};

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY is not set on the server' });
    return;
  }
  const amount = Math.round(Number(amountCents));
  if (!requestId || !amount || amount < 50) {
    // Stripe requires at least ~$0.50 for a USD charge.
    res.status(400).json({ error: 'missing-or-invalid-params' });
    return;
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl || '');
  params.append('cancel_url', cancelUrl || '');
  params.append('client_reference_id', requestId);
  params.append('metadata[requestId]', requestId);
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][unit_amount]', String(amount));
  params.append('line_items[0][price_data][product_data][name]', `Mentorship session with ${mentorName || 'your mentor'}`);

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
