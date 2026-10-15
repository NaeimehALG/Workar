-- Safety: reports, blocks and bans. Run once in Supabase → SQL Editor.

-- 1. Banned accounts (only the admin or the server can ban / lift a ban)
alter table public.profiles add column if not exists banned boolean not null default false;

create or replace function public.protect_profile_approval()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $function$
begin
  if coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com'
     or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.approved := false;
    new."isAdmin" := false;
    new."aiCredits" := least(coalesce(new."aiCredits", 5), 5);
    new.banned := false;
  else
    -- switching role (e.g. client -> mentor) needs a fresh review by the admin
    new.approved := case when new.role is distinct from old.role then false else old.approved end;
    new."isAdmin" := old."isAdmin";
    new."aiCredits" := old."aiCredits";
    new.banned := old.banned;
  end if;
  return new;
end $function$;

create or replace function public.is_banned(u text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.banned from public.profiles p where p.id = u), false)
$$;

-- 2. Blocks: a person you block cannot message you or book you
create table if not exists public.blocks (
  "blockerId" text not null,
  "blockedId" text not null,
  "createdAt" timestamptz not null default now(),
  primary key ("blockerId", "blockedId")
);
alter table public.blocks enable row level security;
drop policy if exists "own blocks read" on public.blocks;
create policy "own blocks read" on public.blocks for select to authenticated using ("blockerId" = (select auth.uid())::text);
drop policy if exists "own blocks add" on public.blocks;
create policy "own blocks add" on public.blocks for insert to authenticated with check ("blockerId" = (select auth.uid())::text and "blockedId" <> "blockerId");
drop policy if exists "own blocks remove" on public.blocks;
create policy "own blocks remove" on public.blocks for delete to authenticated using ("blockerId" = (select auth.uid())::text);

create or replace function public.is_blocked(a text, b text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.blocks x where (x."blockerId" = a and x."blockedId" = b) or (x."blockerId" = b and x."blockedId" = a))
$$;
revoke execute on function public.is_blocked(text, text) from anon, public;
revoke execute on function public.is_banned(text) from anon, public;
grant execute on function public.is_blocked(text, text) to authenticated;
grant execute on function public.is_banned(text) to authenticated;

-- 3. Reports (written by the server; read and resolved by the admin)
create table if not exists public.safety_reports (
  id text primary key,
  "reporterId" text not null,
  "reportedId" text not null,
  "requestId" text,
  category text not null,
  text text not null,
  status text not null default 'open',
  "resolvedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
alter table public.safety_reports enable row level security;
drop policy if exists "admin reads reports" on public.safety_reports;
create policy "admin reads reports" on public.safety_reports for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com');
drop policy if exists "admin resolves reports" on public.safety_reports;
create policy "admin resolves reports" on public.safety_reports for update to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com')
  with check (lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com');

-- 4. Enforce blocks and bans on messages and bookings
alter policy "dm send" on public.messages with check (
  "senderId" = (auth.uid())::text and "requestId" like 'dm\_%' and position((auth.uid())::text in "requestId") > 0
  and not public.is_banned((auth.uid())::text)
  and not public.is_blocked(split_part("requestId", '_', 2), split_part("requestId", '_', 3))
);
alter policy "messages send" on public.messages with check (
  "senderId" = (auth.uid())::text and not public.is_banned((auth.uid())::text)
  and exists (select 1 from public.requests r where r.id = messages."requestId"
              and ((auth.uid())::text = r."mentorId" or (auth.uid())::text = r."clientId")
              and not public.is_blocked(r."mentorId", r."clientId"))
);
alter policy "client insert requests" on public.requests with check (
  (auth.uid())::text = "clientId" and not public.is_banned((auth.uid())::text) and not public.is_blocked("mentorId", "clientId")
);

-- 5. Banned mentors disappear from the public listing
alter policy "public read profiles" on public.profiles using (
  (role = 'mentor' and approved is not false and banned is not true)
  or id = (auth.uid())::text
  or lower(coalesce(auth.jwt() ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com'
  or exists (
    select 1 from public.requests r
    where (r."mentorId" = (auth.uid())::text and r."clientId" = profiles.id)
       or (r."clientId" = (auth.uid())::text and r."mentorId" = profiles.id)
  )
  or exists (
    select 1 from public.messages m
    where m."requestId" = 'dm_' || least((auth.uid())::text collate "C", profiles.id collate "C")
                         || '_' || greatest((auth.uid())::text collate "C", profiles.id collate "C")
  )
);
