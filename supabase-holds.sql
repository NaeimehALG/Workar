-- Card holds (TaskRabbit-style): the client's card is held, and only charged after the session happens.
-- Run once in Supabase → SQL Editor. Safe to run again.

alter table public.requests add column if not exists "holdStatus" text;              -- saved | authorized | captured | released | failed | expired
alter table public.requests add column if not exists "holdAmountCents" integer;
alter table public.requests add column if not exists "stripePaymentIntentId" text;
alter table public.requests add column if not exists "stripeCustomerId" text;
alter table public.requests add column if not exists "stripePaymentMethodId" text;
alter table public.requests add column if not exists "holdCaptureBefore" timestamptz;
alter table public.requests add column if not exists "holdAt" timestamptz;
alter table public.requests add column if not exists "capturedAt" timestamptz;
alter table public.requests add column if not exists "holdError" text;
alter table public.requests add column if not exists "cancelledAt" timestamptz;
alter table public.requests add column if not exists "cancelledBy" text;

-- One Stripe customer per Workar user (server-only: no policies, so only the service role can read/write)
create table if not exists public.stripe_customers (
  "userId" text primary key,
  "customerId" text not null,
  "createdAt" timestamptz default now()
);
alter table public.stripe_customers enable row level security;

-- Hold fields are written only by the server (or the admin); cancellations record who and when
create or replace function public.protect_hold()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  if tg_op = 'INSERT' then
    new."holdStatus" := null; new."holdAmountCents" := null; new."stripePaymentIntentId" := null;
    new."stripeCustomerId" := null; new."stripePaymentMethodId" := null; new."holdCaptureBefore" := null;
    new."holdAt" := null; new."capturedAt" := null; new."holdError" := null;
    new."cancelledAt" := null; new."cancelledBy" := null;
    return new;
  end if;
  if (new."holdStatus" is distinct from old."holdStatus"
      or new."holdAmountCents" is distinct from old."holdAmountCents"
      or new."stripePaymentIntentId" is distinct from old."stripePaymentIntentId"
      or new."stripeCustomerId" is distinct from old."stripeCustomerId"
      or new."stripePaymentMethodId" is distinct from old."stripePaymentMethodId"
      or new."holdCaptureBefore" is distinct from old."holdCaptureBefore"
      or new."holdAt" is distinct from old."holdAt"
      or new."capturedAt" is distinct from old."capturedAt"
      or new."holdError" is distinct from old."holdError")
     and coalesce(lower(auth.jwt() ->> 'email'), '') <> 'naeimeh.alaghehband@gmail.com' then
    raise exception 'Payment details are managed by Workar automatically';
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new."cancelledAt" := now();
    new."cancelledBy" := auth.uid()::text;
  elsif new."cancelledAt" is distinct from old."cancelledAt" or new."cancelledBy" is distinct from old."cancelledBy" then
    new."cancelledAt" := old."cancelledAt"; new."cancelledBy" := old."cancelledBy";
  end if;
  return new;
end $$;

drop trigger if exists protect_hold on public.requests;
create trigger protect_hold before insert or update on public.requests
  for each row execute function public.protect_hold();
