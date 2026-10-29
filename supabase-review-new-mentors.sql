-- Applied to production on 2026-10-24 (migration: server_side_new_mentor_review).
-- Reviews new mentor applications from the server, without relying on the applicant's browser.
-- Every 15 minutes: if a pending mentor signed up 10+ minutes ago and has never been reviewed
-- (no approve/ask/decline event), call the existing one-time review endpoint (/ops/review).
-- Each mentor is retried at most once per hour if the review could not run.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.workar_review_new_mentors() returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare tok text; due int;
begin
  with due_m as (
    select p.id from public.profiles p
    join auth.users u on u.id::text = p.id
    where p.role = 'mentor' and p.approved = false and coalesce(p.banned, false) = false
      and u.created_at < now() - interval '10 minutes'
      and not exists (select 1 from public.agent_events e
                      where e.id in ('ask:' || p.id, 'decline:' || p.id, 'approve:' || p.id))
  ), marked as (
    insert into public.agent_events (id, kind, ref, "createdAt")
    select 'cron-review:' || id || ':' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'), 'cron-review', id, now()
    from due_m
    on conflict (id) do nothing
    returning 1
  )
  select count(*) into due from marked;
  if due = 0 then return; end if;
  tok := md5(random()::text || clock_timestamp()::text) || md5(clock_timestamp()::text || random()::text);
  insert into public.agent_events (id, kind, ref, "createdAt") values ('review-now:' || tok, 'review-now', 'cron', now());
  perform net.http_get('https://workar.me/ops/review?token=' || tok, timeout_milliseconds := 60000);
end $$;

revoke all on function public.workar_review_new_mentors() from public, anon, authenticated;

select cron.schedule('workar-review-new-mentors', '*/15 * * * *', $$select public.workar_review_new_mentors()$$);

-- Oct 25 2026: also re-review applicants whose current profile version has no AI verdict yet
-- (edited after being asked, or an earlier AI call failed). Applied live as migration review_changed_mentor_profiles.
-- See that migration for workar_profile_print() and the updated workar_review_new_mentors().

-- Oct 29 2026 (migration mentor_drafts_wait_an_hour): mentor profiles created at sign-up with only a name
-- (no bio, no LinkedIn) are reviewed only after an hour, so nobody is emailed while still filling in the form.
