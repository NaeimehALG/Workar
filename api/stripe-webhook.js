// Vercel Serverless Function: Stripe webhook. When a Checkout Session completes, this marks
// the matching request as paid in Supabase using the SERVICE ROLE key — which must only ever
// live here, as a Vercel Environment Variable, never in index.html or any client-side code.
//
// Set these Environment Variables in Vercel:
//   STRIPE_WEBHOOK_SECRET      (Stripe Dashboard > Developers > Webhooks > your endpoint > Signing secret)
//   SUPABASE_URL               (same project URL used in index.html, e.g. https://xxxx.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY  (Supabase Project Settings > API > service_role key — NOT the anon key)
//
// After deploying, add a webhook endpoint in Stripe pointing to:
//   https://YOUR-VERCEL-DOMAIN/api/stripe-webhook
// listening for the "checkout.session.completed" event.

const crypto = require('crypto');

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(p => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'server-not-configured' });
    return;
  }

  const rawBody = await readRawBody(req);
  const sig = req.headers['stripe-signature'];

  if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
    res.status(400).json({ error: 'invalid-signature' });
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    res.status(400).json({ error: 'invalid-json' });
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const requestId = (session.metadata && session.metadata.requestId) || session.client_reference_id;
    if (requestId) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}`, {
          method: 'PATCH',
          headers: {
            apikey: serviceKey,
            Authorization: 'Bearer ' + serviceKey,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({ paid: true, stripeSessionId: session.id })
        });
      } catch (e) {
        console.error('supabase-update-failed', e);
      }
    }
  }

  res.status(200).json({ received: true });
};
