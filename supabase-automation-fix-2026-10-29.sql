-- 2026-10-29: automation fixes. NOT YET APPLIED: the apply_migration call (name automation_fix_2026_10_29) was
-- declined at the approval prompt. Run this whole file once in Supabase (SQL editor) to apply it.
-- Already done live: the Vault secret "digest_check_key" was created on 2026-10-29.
-- 1. Missing-digest alert: every day at 17:30 UTC (the daily run starts at 16:00 UTC and may run 5 minutes),
--    if agent_events has no row "digest:<today, UTC>", call https://workar.me/api/reminders?task=digest_check,
--    which emails the team inbox. The key is kept in Supabase Vault ("digest_check_key") and in Vercel as
--    DIGEST_CHECK_KEY (same value). To change it, update both.
-- 2. The 15-minute mentor review stops retrying an applicant once the AI review of the same profile version failed
--    3 times (agent_events kind "review_fail", ref "<id>:<fingerprint>|<time>", written by api/_autopilot.js);
--    the daily digest then lists it under "Needs you". It is reviewed again as soon as the profile changes.
-- 3. Monthly cleanup (1st of the month, 09:17 UTC): deletes agent_events rows older than 30 days of the
--    log and rate-limit counter kinds only, and cron.job_run_details older than 30 days.
--    Never deleted: once-only markers (approve, ask, decline, finish-profile, confirm-nudge, verdict, en, details,
--    resume, digest, ...), which stop emails or AI calls from repeating.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- done once on 2026-10-29 (already exists; do not run again), the value is not kept in this file:
-- select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'digest_check_key', 'Key for api/reminders?task=digest_check (Vercel DIGEST_CHECK_KEY)');

create or replace function public.workar_digest_check() returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare k text;
begin
  if exists (select 1 from public.agent_events where id = 'digest:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD')) then return; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name = 'digest_check_key' limit 1;
  if k is null then raise warning 'workar_digest_check: vault secret digest_check_key is missing'; return; end if;
  perform net.http_get(
    url := 'https://workar.me/api/reminders?task=digest_check',
    headers := jsonb_build_object('x-digest-key', k),
    timeout_milliseconds := 30000);
end $$;
revoke all on function public.workar_digest_check() from public, anon, authenticated;

select cron.unschedule('workar-digest-check') where exists (select 1 from cron.job where jobname = 'workar-digest-check');
select cron.schedule('workar-digest-check', '30 17 * * *', $$select public.workar_digest_check()$$);

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
      -- 2026-10-29: a profile only started at sign-up (no bio, no LinkedIn) waits an hour, so someone
      -- still filling in the mentor form isn't emailed "please add ..." in the middle of it.
      and (coalesce(btrim(p.bio), '') <> '' or coalesce(btrim(p.linkedin), '') <> '' or u.created_at < now() - interval '1 hour')
      and not exists (select 1 from public.agent_events e where e.id in ('decline:' || p.id, 'approve:' || p.id))
      and (not exists (select 1 from public.agent_events e where e.id = 'ask:' || p.id)
           or not exists (select 1 from public.agent_events e where e.id = 'verdict:' || p.id || ':' || public.workar_profile_print(p)))
      -- 2026-10-29: backoff, no more AI calls after 3 failed reviews of this profile version
      and (select count(*) from public.agent_events e
           where e.kind = 'review_fail' and e.ref like p.id || ':' || public.workar_profile_print(p) || '|%') < 3
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

create or replace function public.workar_cleanup_logs() returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Logs and rate-limit counters (counted over the last 1 to 24 hours by api/agents.js, api/ai.js, api/tts.js,
  -- api/notify.js); rows older than 30 days are never read.
  delete from public.agent_events
  where "createdAt" < now() - interval '30 days'
    and kind in ('cron-review', 'review-now', 'auth_mail', 'pub_ai', 'notice', 'coach', 'tts',
                 'ai_translate', 'ai_brief', 'ai_onboard', 'ai_followup', 'ai_price', 'ai_note', 'ai_review',
                 'ai_reply', 'ai_resume', 'ai_guard');
  delete from cron.job_run_details where end_time < now() - interval '30 days';
end $$;
revoke all on function public.workar_cleanup_logs() from public, anon, authenticated;

select cron.unschedule('workar-cleanup-logs') where exists (select 1 from cron.job where jobname = 'workar-cleanup-logs');
select cron.schedule('workar-cleanup-logs', '17 9 1 * *', $$select public.workar_cleanup_logs()$$);
