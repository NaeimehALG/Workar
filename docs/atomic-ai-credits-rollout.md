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
SQL execution, production schema inspection, historical reconciliation and live
Stripe replay verification remain pending until Supabase access is connected.

This change does not audit existing profile-update policies. Preventing clients
from editing their own credit balance is a separate required database privacy check.
