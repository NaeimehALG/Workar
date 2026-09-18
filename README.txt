Workar — production setup (shared database + real AI)
========================================================

This folder has everything needed for a real, shared version of Workar:
- index.html         → the app (edit 2 lines near the top of the <script> for Supabase)
- api/ai.js          → a Vercel serverless function that calls Anthropic's API (keeps your key private)
- supabase-setup.sql → run this once inside Supabase to create your tables

STEP 1 — Create a Supabase project (free)
  1. Go to https://supabase.com and sign up / log in.
  2. Create a new project (pick any name/region, free tier is fine).
  3. Once it's ready, go to Authentication > Providers > Anonymous and enable "Allow anonymous sign-ins".
  4. Go to the SQL Editor, paste the contents of supabase-setup.sql, and run it.
  5. Go to Project Settings > API. Copy your "Project URL" and your "anon public" key.

STEP 2 — Connect index.html to Supabase
  Open index.html in a text editor, find these two lines near the top of the <script> block:
      const SUPABASE_URL = 'YOUR_SUPABASE_URL';
      const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
  Replace them with the values you copied in Step 1.

STEP 3 — Get an Anthropic API key (for the AI coach + AI matching)
  1. Go to https://console.anthropic.com, sign up, and create an API key.
  2. Keep this key secret — do not put it in index.html. It only goes in Vercel (next step).

STEP 4 — Deploy to Vercel
  1. Go to https://vercel.com, sign up / log in.
  2. Click "Add New" > "Project" > choose to deploy without Git (drag & drop).
  3. Drag this whole "workar" folder (with index.html AND the api folder inside it) into Vercel.
  4. After it deploys, go to your Project > Settings > Environment Variables.
  5. Add a variable named ANTHROPIC_API_KEY with the key from Step 3. Save.
  6. Redeploy the project (Vercel > Deployments > ... > Redeploy) so the new env variable takes effect.

STEP 5 — Test it
  Open your Vercel URL. Sign up as a mentor from one browser (or incognito window) and as a client
  from another — you should now see the SAME mentor list and reviews in both, because they're stored
  in your shared Supabase database instead of just your own browser.

Notes
  - Anonymous Supabase sign-in means each visitor gets a stable identity without needing to make an
    account — good for a demo/MVP, but anyone could in principle create many "identities". Real
    accounts (email/password or magic link) are a further step if you want that later.
  - Your custom domain (.ca / .me) connects the same way as before: Vercel Project > Settings > Domains.


NEW — Video / voice calls
==========================
Mentors and clients get a "Join video/voice call" button once a request is accepted (and paid,
if the mentor charges — see below). It opens a free Jitsi Meet room (https://meet.jit.si) named
after the request, in a new tab. No signup, no API key, no extra setup needed — video, audio-only
(mute the camera inside Jitsi), and screen share all work out of the box. Anyone with the exact
link can join, so treat it like a private meeting link.


NEW — Payments (Stripe)
========================
Mentors can now set a price (in USD) on their profile. When a mentor accepts a request that has
a price attached, the client sees a "Pay $X to confirm" button; once they pay, both sides see
"Join video/voice call" instead.

STEP 1 — Get Stripe keys
  1. Go to https://dashboard.stripe.com, sign up / log in (test mode is fine to start).
  2. Developers > API keys — copy your "Secret key" (starts with sk_).

STEP 2 — Add environment variables in Vercel
  Project > Settings > Environment Variables, add:
    STRIPE_SECRET_KEY          = your Stripe secret key
    SUPABASE_URL                = same Supabase project URL used in index.html
    SUPABASE_SERVICE_ROLE_KEY   = Supabase Project Settings > API > "service_role" key
                                  (NOT the anon key — this one bypasses row-level security,
                                  so it must only ever be a server-side env var, never in index.html)
  Redeploy after saving so the new variables take effect.

STEP 3 — Run the extra SQL
  In Supabase SQL Editor, run the new lines added at the bottom of supabase-setup.sql
  (adds a price field to mentor profiles, and payment fields to requests).

STEP 4 — Set up the Stripe webhook (confirms payment happened for real)
  1. In Stripe Dashboard: Developers > Webhooks > "Add endpoint".
  2. Endpoint URL: https://YOUR-VERCEL-DOMAIN/api/stripe-webhook
  3. Select event: checkout.session.completed
  4. After creating it, copy the "Signing secret" (starts with whsec_) and add it to Vercel as:
       STRIPE_WEBHOOK_SECRET
  5. Redeploy.

STEP 5 — Test it
  As a mentor, set a price on your profile. From another browser/incognito window, request that
  mentor as a client, then accept the request as the mentor. As the client, click "Pay to confirm"
  — Stripe's test mode card is 4242 4242 4242 4242, any future expiry date, any CVC. After paying,
  you'll be redirected back and, within a few seconds, both sides should see "Join video/voice call".

  Go live later by switching to your live Stripe keys (and a live webhook endpoint) once you're
  ready to take real payments — Stripe itself handles all card data, none of it touches your code.

A heads-up on the existing schema
  The original supabase-setup.sql uses snake_case columns (mentor_id, client_id, created_at) but
  index.html writes camelCase fields (mentorId, clientId, createdAt). If your live "requests" table
  was created from that original script as-is, inserts from the app may be failing silently on that
  mismatch — worth checking your Supabase table's actual column names against what index.html sends,
  and renaming the columns to camelCase (with quotes) if needed so requests save correctly.
