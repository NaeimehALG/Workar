-- Life coaching (2026-11-01): a coach shows on the Life Coaching page only after the admin has
-- checked their ICF credential. The coach enters their ICF credential number or ICF Coach Finder
-- link ("coachIcfId"); only the admin (or the server) can set "coachIcfOk". Changing the level or
-- the credential sends it back for a new check.
alter table public.profiles add column if not exists "coachIcfId" text;
alter table public.profiles add column if not exists "coachIcfOk" boolean not null default false;

create or replace function public.protect_coach_credential()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com'
     or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new."coachIcfOk" := false;
  elsif new."coachIcf" is distinct from old."coachIcf" or new."coachIcfId" is distinct from old."coachIcfId" then
    new."coachIcfOk" := false;
  else
    new."coachIcfOk" := old."coachIcfOk";
  end if;
  if new."coachIcf" is null then new."coachIcfOk" := false; end if;
  return new;
end $$;

drop trigger if exists protect_coach_credential on public.profiles;
create trigger protect_coach_credential before insert or update on public.profiles
  for each row execute function public.protect_coach_credential();

-- Mentor sign-up asks how the person joins: professional in their field, HR / recruiter, or certified life coach.
alter table public.profiles add column if not exists "mentorKind" text;
alter table public.profiles drop constraint if exists profiles_mentor_kind_check;
alter table public.profiles add constraint profiles_mentor_kind_check check ("mentorKind" is null or "mentorKind" in ('pro','hr','coach'));
