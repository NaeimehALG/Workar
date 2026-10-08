process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Vercel Serverless Function: Stripe webhook. When a Checkout Session completes, this records the
// result in Supabase using the SERVICE ROLE key — which must only ever live here, as a Vercel
// Environment Variable, never in index.html or any client-side code.
//
// Handles three kinds of purchase (set in metadata[kind] by /api/create-checkout):
//   booking    — marks the mentoring request as paid, creates the private call link,
//                and emails mentor + client the link with a calendar invite
//   ai_credits — adds AI coaching messages to the buyer's profile
//   exam       — unlocks a PMP Prep mock exam (or the all-access pass) for the buyer
//
// Environment Variables in Vercel:
//   STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const crypto = require('crypto');

async function checkedFetch(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error('database-write-failed');
  return response;
}

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
  // reject replays of old events (Stripe's recommended 5-minute tolerance)
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
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
    // only act on money that actually arrived (e.g. ignore delayed bank payments still pending)
    if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      res.status(200).json({ received: true, skipped: 'unpaid' }); return;
    }
    try {
      if (md.kind === 'exam' && md.userId && md.examId) {
        // stripeSessionId is unique, so a repeated webhook delivery is ignored
        await checkedFetch(`${supabaseUrl}/rest/v1/exam_purchases?on_conflict=stripeSessionId`, {
          method: 'POST',
          headers: Object.assign({ Prefer: 'resolution=ignore-duplicates,return=minimal' }, h),
          body: JSON.stringify({ userId: md.userId, examId: md.examId, stripeSessionId: session.id })
        });
      } else if (md.kind === 'ai_credits' && md.userId) {
        // Atomic + idempotent: the purchase ledger keyed by Stripe session id means a re-sent webhook never grants twice.
        await checkedFetch(`${supabaseUrl}/rest/v1/rpc/grant_ai_credit_purchase`, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, h),
          body: JSON.stringify({ p_session_id: session.id, p_user_id: String(md.userId), p_credits: Number(md.credits) || 20 })
        });
      } else {
        const requestId = md.requestId || session.client_reference_id;
        if (requestId) {
          await checkedFetch(`${supabaseUrl}/rest/v1/requests?id=eq.${encodeURIComponent(requestId)}`, {
            method: 'PATCH',
            headers: Object.assign({ Prefer: 'return=minimal' }, h),
            body: JSON.stringify({ paid: true, stripeSessionId: session.id })
          });
          // private meeting link + confirmation email with calendar invite to BOTH people.
          // Runs once per booking (safe if Stripe re-sends the webhook) and never blocks the payment update.
          try {
            await require('./_session').confirmPaidSession(requestId);
          } catch (e) { console.error('session-confirm-failed', e); }
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
