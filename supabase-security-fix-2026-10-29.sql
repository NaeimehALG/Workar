-- Workar security fixes, 2026-10-29. APPLIED on 2026-10-29 (approved by the owner); earlier note: to the live project (jgbjhzhbdsdhssyakpgq):
-- the apply_migration call ("security_fix_2026_10_29") was cancelled. Run this whole file once in the
-- Supabase SQL editor (or apply it as that migration). Safe to re-run.
-- The live protect_request / protect_request_insert functions are NOT changed here.

-- Helpers live in a schema the REST API does not expose, so they can't be called as /rpc/... endpoints.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Private files (bucket "files"): reading someone else's file
-- Before: anyone with ANY booking with the owner, or any DM thread with them (and anyone can DM a live
-- mentor), could list and read the owner's whole folder.
-- Now another person's file is readable only when
--   a) the owner attached that exact file (messages.attachment->>'path') to a message they sent in a
--      thread both people are in (their DM thread, or a booking thread between the two), or
--   b) it is the owner's current resume (profiles."resumePath") and the two have a booking:
--      a mentor sees the client's resume on pending / accepted requests (the request card shows it),
--      a client sees a mentor's resume only once the booking is accepted.
-- Owners and the admin keep full access. Server code uses the service key and is unaffected.
-- ---------------------------------------------------------------------------------------------
create or replace function private.can_read_shared_file(p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  with ctx as (
    select (select auth.uid())::text as me, split_part(p_name, '/', 1) as owner
  )
  select coalesce((
    select ctx.me is not null and ctx.owner <> '' and ctx.owner <> ctx.me and (
      exists (
        select 1 from public.messages m
        where m.attachment ->> 'path' = p_name
          and m."senderId" = ctx.owner
          and (
            m."requestId" = 'dm_' || least(ctx.me collate "C", ctx.owner collate "C") || '_' || greatest(ctx.me collate "C", ctx.owner collate "C")
            or exists (select 1 from public.requests r where r.id = m."requestId"
                         and ((r."mentorId" = ctx.me and r."clientId" = ctx.owner) or (r."clientId" = ctx.me and r."mentorId" = ctx.owner)))
          )
      )
      or exists (
        select 1 from public.profiles p
        join public.requests r on (
             (r."mentorId" = ctx.me and r."clientId" = p.id and r.status in ('pending', 'accepted'))
          or (r."clientId" = ctx.me and r."mentorId" = p.id and r.status = 'accepted'))
        where p.id = ctx.owner and p."resumePath" = p_name
      )
    )
    from ctx), false)
$$;
revoke all on function private.can_read_shared_file(text) from public, anon;
grant execute on function private.can_read_shared_file(text) to authenticated;

drop policy if exists "files read shared" on storage.objects;
create policy "files read shared" on storage.objects for select to authenticated using (
  bucket_id = 'files' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com'
    or private.can_read_shared_file(name)
  )
);

-- ---------------------------------------------------------------------------------------------
-- 2. Approved mentors who change their public identity go back through the automatic review.
-- When an approved mentor (not the admin, not the server / service_role) changes name, headline,
-- profession, company, bio or linkedin, approved becomes false. The server-side English translation,
-- fillDetails and LinkedIn photo sync write with the service key, so they never trigger this.
-- The "approve:<id>" memory row is removed at the same time: without that, the 15-minute job
-- (workar_review_new_mentors) and the review in api/_autopilot.js (once('approve', id)) would skip
-- this mentor forever and the profile would stay hidden.
-- ---------------------------------------------------------------------------------------------
create or replace function public.protect_profile_approval()
returns trigger language plpgsql security definer set search_path = public as $$
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
    new."linkedinVerified" := false;
  else
    new.approved := case when new.role is distinct from old.role then false else old.approved end;
    if old.role = 'mentor' and old.approved is not false and (
         new.name is distinct from old.name or new.headline is distinct from old.headline
      or new.profession is distinct from old.profession or new.company is distinct from old.company
      or new.bio is distinct from old.bio or new.linkedin is distinct from old.linkedin) then
      new.approved := false;
      delete from public.agent_events where id = 'approve:' || old.id;
      -- marker so the review code can tell a re-review of a formerly live mentor from a new application
      insert into public.agent_events (id, kind, ref, "createdAt") values ('rereview:' || old.id, 'rereview', old.id, now())
        on conflict (id) do update set "createdAt" = excluded."createdAt";
    end if;
    new."isAdmin" := old."isAdmin";
    new."aiCredits" := old."aiCredits";
    new.banned := old.banned;
    new."linkedinVerified" := old."linkedinVerified";
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Anyone (even signed out) could upload to the public bucket "social-tmp". Nothing in the repo uses it
-- and the bucket is empty.
-- ---------------------------------------------------------------------------------------------
drop policy if exists "tmp social upload k7q2" on storage.objects;

-- ---------------------------------------------------------------------------------------------
-- 7. Reviews hidden by the admin are no longer readable by everyone: visible reviews for all,
-- every review for the admin, and a hidden review only for the client who wrote it.
-- ---------------------------------------------------------------------------------------------
drop policy if exists "public read reviews" on public.reviews;
create policy "public read reviews" on public.reviews for select using (
  coalesce(hidden, false) = false
  or "clientId" = (select auth.uid())::text
  or lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com'
);

-- ---------------------------------------------------------------------------------------------
-- 8. A reported sender can no longer delete their messages to the person who reported them.
-- A message is kept when there is a safety report against its sender that concerns that thread:
-- the report names the same thread (booking id, or the AI payment guard's thread id), or the reporter is
-- the other person in the message's thread (DM thread or booking thread). safety_reports is only readable
-- by the admin, so this check runs as a definer function.
-- ---------------------------------------------------------------------------------------------
create or replace function private.message_is_evidence(p_thread text, p_sender text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.safety_reports sr
    where sr."reportedId" = p_sender
      and (
        sr."requestId" = p_thread
        or (p_thread like 'dm\_%' and p_thread = 'dm_' || least(sr."reporterId" collate "C", p_sender collate "C") || '_' || greatest(sr."reporterId" collate "C", p_sender collate "C"))
        or exists (select 1 from public.requests r where r.id = p_thread
                     and ((r."mentorId" = p_sender and r."clientId" = sr."reporterId") or (r."clientId" = p_sender and r."mentorId" = sr."reporterId")))
      )
  )
$$;
revoke all on function private.message_is_evidence(text, text) from public, anon;
grant execute on function private.message_is_evidence(text, text) to authenticated;

drop policy if exists "delete own messages" on public.messages;
create policy "delete own messages" on public.messages for delete to authenticated using (
  "senderId" = (select auth.uid())::text
  and not private.message_is_evidence("requestId", "senderId")
);

-- ---------------------------------------------------------------------------------------------
-- 9. SECURITY DEFINER functions callable through /rest/v1/rpc
--   workar_package, workar_package_sessions, workar_price_cents: only used inside the booking triggers
--     (protect_request / protect_request_insert, SECURITY DEFINER owned by postgres), never by the site.
--   mentor_busy: the site calls it only from the booking panel, which is shown to signed-in users.
--   reviewer_names: KEPT for anon + authenticated: signed-out visitors see reviewer names (first name +
--     last initial) on a mentor's page (index.html resolveReviewerNames via loadReviews).
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.workar_package(text) from public, anon, authenticated;
revoke execute on function public.workar_package_sessions(text) from public, anon, authenticated;
revoke execute on function public.workar_price_cents(text, text) from public, anon, authenticated;
grant execute on function public.workar_package(text) to service_role;
grant execute on function public.workar_package_sessions(text) to service_role;
grant execute on function public.workar_price_cents(text, text) to service_role;
revoke execute on function public.mentor_busy(text) from public, anon;
grant execute on function public.mentor_busy(text) to authenticated, service_role;
