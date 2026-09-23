// Vercel Serverless Function: Stripe webhook. When a Checkout Session completes, this records the
// result in Supabase using the SERVICE ROLE key — which must only ever live here, as a Vercel
// Environment Variable, never in index.html or any client-side code.
//
// Handles three kinds of purchase (set in metadata[kind] by /api/create-checkout):
//   booking    — marks the mentoring request as paid
//   ai_credits — adds AI coaching messages to the buyer's profile
//   exam       — unlocks a PMP Prep mock exam (or the all-access pass) for the buyer
//
// Environment Variables in Vercel:
//   STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const crypto = require('crypto');

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
    const i = p.indexOf('=');
    const k = p.slice(0, i), v = p.slice(i + 1);
    if (k === 'v1' && parts.v1) return; // keep the first v1 signature
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

async function handler(req, res) {
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
  try { event = JSON.parse(rawBody); } catch (e) {
    res.status(400).json({ error: 'invalid-json' });
    return;
  }

  const h = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json'
  };

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};
    try {
      if (md.kind === 'exam' && md.userId && md.examId) {
        // stripeSessionId is unique, so a repeated webhook delivery is ignored
        await fetch(`${supabaseUrl}/rest/v1/exam_purchases?on_conflict=stripeSessionId`, {
          method: 'POST',
          headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=minimal' }, h),
          body: JSON.stringify({ userId: md.userId, examId: md.examId, stripeSessionId: session.id })
        });
      } else if (md.kind === 'ai_credits' && md.userId) {
        const r = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(md.userId)}&select=aiCredits`, { headers: h });
        const rows = await r.json();
        const current = (Array.isArray(rows) && rows[0] && Number(rows[0].aiCredits)) || 0;
        await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(md.userId)}`, {
          method: 'PATCH',
          headers: Object.assign({ Prefer: 'return=minimal' }, h),
          body: JSON.stringify({ aiCredits: current + (Number(md.credits) || 20) })
        });
      } else {
        const requestId = md.requestId || session.client_reference_id;
        if (requestId) {
          await fetch(`${supabaseUrl}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}`, {
            method: 'PATCH',
            headers: Object.assign({ Prefer: 'return=minimal' }, h),
            body: JSON.stringify({ paid: true, stripeSessionId: session.id })
          });
        }
      }
    } catch (e) {
      console.error('supabase-update-failed', e);
      res.status(500).json({ error: 'update-failed' }); // Stripe will retry
      return;
    }
  }

  res.status(200).json({ received: true });
}

module.exports = handler;
// Must be set AFTER module.exports is assigned, or Vercel ignores it
module.exports.config = { api: { bodyParser: false } };
