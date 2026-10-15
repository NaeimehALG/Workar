-- Dispute agent (api/_dispute.js). Run once in Supabase → SQL Editor.
alter table public.requests add column if not exists "disputeOpenedAt" timestamptz;
alter table public.requests add column if not exists "disputeAnalyzedAt" timestamptz;
alter table public.requests add column if not exists "disputeSummary" text;
alter table public.requests add column if not exists "disputeRecommendation" text;
alter table public.requests add column if not exists "disputeEvidence" jsonb;

-- Each side's account. Written and read only by the server (service role) and the admin.
create table if not exists public.dispute_statements (
  id text primary key,
  "requestId" text not null,
  "authorId" text not null,
  role text not null check (role in ('mentor','client')),
  text text not null,
  "createdAt" timestamptz not null default now()
);
create index if not exists dispute_statements_request on public.dispute_statements ("requestId");
alter table public.dispute_statements enable row level security;
drop policy if exists "admin reads statements" on public.dispute_statements;
create policy "admin reads statements" on public.dispute_statements for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com');

-- Only the server and the admin can write the agent's findings on a booking.
create or replace function public.protect_dispute()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new."disputeOpenedAt" := null; new."disputeAnalyzedAt" := null; new."disputeSummary" := null;
    new."disputeRecommendation" := null; new."disputeEvidence" := null;
    return new;
  end if;
  if new."disputeOpenedAt" is distinct from old."disputeOpenedAt"
     or new."disputeAnalyzedAt" is distinct from old."disputeAnalyzedAt"
     or new."disputeSummary" is distinct from old."disputeSummary"
     or new."disputeRecommendation" is distinct from old."disputeRecommendation"
     or new."disputeEvidence" is distinct from old."disputeEvidence" then
    raise exception 'This change is not allowed';
  end if;
  return new;
end $function$;
drop trigger if exists protect_dispute on public.requests;
create trigger protect_dispute before insert or update on public.requests
  for each row execute function public.protect_dispute();
