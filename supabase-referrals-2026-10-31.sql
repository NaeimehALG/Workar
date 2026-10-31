-- Invite-a-friend links (applied 2026-10-31). Who invited whom, kept private:
-- no one can read rows directly; each person only sees their own count through my_referral_count().
create table if not exists public.referrals (
  invitee text primary key,
  referrer text not null,
  "createdAt" timestamptz not null default now(),
  constraint referrals_not_self check (invitee <> referrer)
);
alter table public.referrals enable row level security;
drop policy if exists "own referral insert" on public.referrals;
create policy "own referral insert" on public.referrals for insert to authenticated
  with check (
    invitee = (select auth.uid())::text
    and referrer <> invitee
    and exists (select 1 from public.profiles p where p.id = referrer)
  );
revoke update, delete on public.referrals from anon, authenticated;

create or replace function public.my_referral_count()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.referrals where referrer = (select auth.uid())::text;
$$;
revoke all on function public.my_referral_count() from public, anon;
grant execute on function public.my_referral_count() to authenticated;
