-- Automatic mentor payouts (Stripe Connect). Safe to run more than once.
create table if not exists public.mentor_payout_accounts (
  "mentorId" text primary key,
  "stripeAccountId" text not null unique,
  "payoutsEnabled" boolean not null default false,
  country text,
  "updatedAt" timestamptz not null default now()
);
alter table public.mentor_payout_accounts enable row level security;
drop policy if exists "own payout account" on public.mentor_payout_accounts;
-- Mentors can see their own row, the admin can see all. Only the server (service role) can write.
create policy "own payout account" on public.mentor_payout_accounts for select to authenticated
  using ("mentorId" = auth.uid()::text or lower(coalesce(auth.jwt() ->> 'email','')) = 'naeimeh.alaghehband@gmail.com');

alter table public.requests
  add column if not exists "stripeChargeId" text,
  add column if not exists "payoutCents" integer,
  add column if not exists "stripeTransferId" text,
  add column if not exists "payoutError" text,
  add column if not exists "payoutNudgedAt" timestamptz;

create or replace function public.protect_payout() returns trigger language plpgsql as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;
  if (new."payoutDone" is distinct from old."payoutDone" or new."payoutAt" is distinct from old."payoutAt")
     and coalesce(lower(auth.jwt() ->> 'email'), '') <> 'naeimeh.alaghehband@gmail.com' then
    raise exception 'Only the Workar admin can record payouts';
  end if;
  if new."stripeChargeId" is distinct from old."stripeChargeId"
     or new."payoutCents" is distinct from old."payoutCents"
     or new."stripeTransferId" is distinct from old."stripeTransferId"
     or new."payoutError" is distinct from old."payoutError"
     or new."payoutNudgedAt" is distinct from old."payoutNudgedAt" then
    raise exception 'Payout details are managed by Workar automatically';
  end if;
  return new;
end $$;
