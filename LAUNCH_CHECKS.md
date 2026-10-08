# Workar launch verification — 7 October 2026

## Implemented and locally verified

- Video/voice prejoin: stale device requests are stopped after closing/reopening; only confirmed-booking participants can open the preview. Voice mode requests no camera. Focus returns on close; keyboard focus stays within the dialog.
- Checkout: authenticated buyer, booking ownership, accepted/unpaid state, server-calculated price, approved return origins, and failure on unavailable price lookups. All three purchase flows send the session token.
- Calendar: Google Calendar and Apple/Outlook downloads on confirmed booking cards and in booking conversations for both participants. UTC times and 45-minute duration; Persian/emoji line folding and invalid-date handling; reminder alarms.
- Support: a ticket is not reported as received when both storage and team email fail. Confirmation delivery is reported accurately. Ticket references use random IDs.
- Payment webhook: database HTTP failures return an error so Stripe can retry rather than reporting a successful payment update.
- Jitsi instructions explain lobby admission, link confidentiality and possible first-participant sign-in.
- The clean-cut, muted hero video was observed playing on the public site.

Run `node --test tests/*.test.js` for the regression suite. Tests use mocks; they do not send emails or make payments.

## Launch gates still requiring live verification/access

1. Two separate mentor/client accounts and two devices: request → accept → test payment → calendar confirmation → both join video, mute/unmute, switch to voice-only, leave/rejoin. Repeat on mobile. Verify screen share and Jitsi moderator/lobby behavior.
2. Supabase policies and actual schema: the bundled setup SQL is outdated (snake_case fields and a public read policy on requests). It does not establish that the deployed database has those policies. Inspect live policies; require participant-only request/message access, service-only payment/credit updates and mentor-approval protection. Booking conflict prevention must be enforced transactionally in the database, not just by the calendar UI.
3. AI-credit webhook idempotency: the existing read-then-increment code can grant credits twice on repeated Stripe deliveries. An atomic database ledger/RPC is required; do not enable paid AI-credit sales until it is installed and retry/concurrency tests pass.
4. Resend: deliver a real confirmation and support escalation to approved test inboxes; verify reply routing. The support assistant must have ANTHROPIC_API_KEY and the ticket table configured.
5. Stripe: verify live/test keys, webhook secret, successful event delivery and safe retry behavior. Mentor payouts shown in the dashboard are not proof of an automated payout integration. Verify the intended payout/refund process before accepting money.
6. Mentor/client profiles: verify saves, photos, approval visibility, availability, rate and timezone edits using both account roles. Public profile browsing is not proof of private-data authorization.

No live payment, customer booking, or email was created as part of this audit. Source-level checks do not certify the app as ready for launch.
