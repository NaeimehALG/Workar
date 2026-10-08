# Atomic AI credit fulfillment

The old webhook adds credits on every delivery and overwrites the current balance
from a stale read. The new webhook calls a service-role-only database transaction:
a unique Checkout Session receipt and an additive balance update commit together.
The AI endpoint also decrements the current balance atomically, preserving grants
that arrive while a reply is being generated.

## Deployment order

1. Inspect the live Supabase schema and confirm profiles.id and "aiCredits" types,
   existing functions, policies and permissions. Do not assume supabase-setup.sql
   describes the current production database.
2. Reconcile historical paid AI Checkout Sessions against fulfillment records.
   Seed ai_credit_purchases only for purchases already credited, without adjusting
   their balance. The old endpoint stored no receipt, so an old successful payment
   alone does not prove fulfillment. Resolve ambiguous purchases before replay.
3. Quiesce the old fulfillment endpoint during reconciliation/migration/cutover
   (a retryable 503 causes Stripe to deliver again). Otherwise an old instance can
   grant credits after ledger reconciliation. Do not replay old sessions yet.
4. Apply supabase/migrations/202610080001_atomic_ai_credits.sql after schema review.
   Run the SQL regression checks in a disposable PostgreSQL database first.
   Verify client roles cannot call these RPCs or access the receipt ledger.
5. Deploy the API changes. Ensure Stripe delivers checkout.session.completed and
   checkout.session.async_payment_succeeded if delayed payment methods are enabled.
6. With a test-mode Checkout Session, send repeated and concurrent deliveries,
   including distinct event IDs for the same session. Confirm one receipt and one
   grant. Verify failed transactions leave no receipt and can be retried; confirm
   two different purchases and an AI debit preserve the balance.

Validation completed: node --test tests/*.test.js, 30 passing tests.
Webhook tests use a database contract model; they do not execute PostgreSQL.
tests/credits.database.sql exercises the real migration in a disposable database.
Supabase connected on 2026-10-08 UTC: production schema inspected and the migration
applied. Real SQL assertions passed using service-role JWT claims, including duplicate
receipts, rollback/retry, missing profiles, balance debits and client permissions.
Six concurrent database calls for one test session produced one grant (5 to 25),
one receipt and five duplicate acknowledgments. Test fixtures were removed.
Historical Stripe reconciliation and end-to-end Stripe replay verification remain
pending Stripe connection; the API branch is still a draft and is not deployed.

The live protect_profile_approval trigger already preserves credit balances on
non-admin/non-service updates and caps starter credits. Broader RLS policy auditing
is outside this change.
