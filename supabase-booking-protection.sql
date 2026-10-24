-- Applied to production on 2026-10-24 (migration: booking_and_privacy_protection).
-- Closes holes found in the Oct 24 code review:
--  * booking IDs: only letters, digits, _ and - (an ID with quotes/HTML could run code on the mentor's dashboard)
--  * bookings can only be made with a real, approved mentor (not with any user id, which exposed private profiles/resumes)
--  * direct messages: only to an approved mentor, or replying in a thread the other person started
--  * booking price is set by the database from the package + mentor rate (a client could insert a $0 booking)
--  * nobody but Workar can preset payout, charge, dispute or review fields on a new booking
--  * session times can only be moved into the future (a mentor could backdate to get charged and paid at once)
--  * the session counter goes up one at a time, only once the session has started, never past the package
--  * the package of a booking can't be changed after it is made

-- 1. Booking ID format
alter table public.requests drop constraint if exists requests_id_format;
alter table public.requests add constraint requests_id_format check (id ~ '^[A-Za-z0-9_-]{1,80}$');

-- 2. Package sessions and price (same rule as api/create-checkout.js)
create or replace function public.workar_package(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  with defaults as (
    select '{"single":{"price":30,"sessions":1},"resume":{"price":55,"sessions":2},"interview":{"price":79,"sessions":3},"offer":{"price":150,"sessions":6}}'::jsonb d
  ), saved as (
    select coalesce((select data->'packages' from public.site_settings where id = 'main'), '[]'::jsonb) s
  )
  select (select d -> k from defaults) || coalesce((select e from saved, jsonb_array_elements(case when jsonb_typeof(s) = 'array' then s else '[]'::jsonb end) e where e->>'key' = k limit 1), '{}'::jsonb)
  from (select case when p_key in ('single','resume','interview','offer') then p_key else 'single' end k) x
$$;

create or replace function public.workar_package_sessions(p_key text) returns int
language sql stable security definer set search_path = public as $$
  select greatest(1, coalesce(nullif(public.workar_package(p_key)->>'sessions','')::numeric, 1))::int
$$;

create or replace function public.workar_price_cents(p_mentor text, p_key text) returns int
language plpgsql stable security definer set search_path = public as $$
declare pkg jsonb := public.workar_package(p_key); single jsonb := public.workar_package('single');
  min_rate numeric; rate numeric; r text;
begin
  min_rate := round(coalesce(nullif(single->>'price','')::numeric, 30) / greatest(1, coalesce(nullif(single->>'sessions','')::numeric, 1)));
  if min_rate is null or min_rate <= 0 then min_rate := 30; end if;
  rate := min_rate;
  select "sessionRate"::text into r from public.profiles where id = p_mentor;
  if r ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' and r::numeric > min_rate then rate := round(r::numeric); end if;
  return (round(coalesce(nullif(pkg->>'price','')::numeric, 30) * rate / min_rate) * 100)::int;
end $$;

-- 3. New bookings: server-decided fields
create or replace function public.protect_request_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com'
     or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if new."startsAt" is not null and new."startsAt" <= now() then
    raise exception 'Please pick a time in the future';
  end if;
  new."packageKey" := case when new."packageKey" in ('single','resume','interview','offer') then new."packageKey" else 'single' end;
  new."amountCents" := public.workar_price_cents(new."mentorId", new."packageKey");
  new.paid := false;
  new."stripeSessionId" := null;
  new.status := 'pending';
  new."sessionsDone" := 0;
  new."payoutDone" := false;
  new."payoutAt" := null;
  new."payoutCents" := null;
  new."stripeChargeId" := null;
  new."stripeTransferId" := null;
  new."payoutError" := null;
  new."payoutNudgedAt" := null;
  new."meetingUrl" := null;
  new."meetingRoom" := null;
  new."prepBrief" := null;
  new."remindedAt" := null;
  new."followupSentAt" := null;
  new."nudgedAt" := null;
  new."proposedTimes" := null;
  new."problemReportedAt" := null;
  new."problemNote" := null;
  new."problemResolvedAt" := null;
  new."clientConfirmedAt" := null;
  new."clientReviewedAt" := null;
  new."disputeOpenedAt" := null;
  new."disputeAnalyzedAt" := null;
  new."disputeSummary" := null;
  new."disputeRecommendation" := null;
  new."disputeEvidence" := null;
  return new;
end $$;

-- 4. Changes to bookings (adds the time, counter and package rules to the existing checks)
create or replace function public.protect_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_admin boolean := coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com';
  is_server boolean := coalesce(auth.role(), '') = 'service_role';
  is_client boolean := auth.uid()::text = old."clientId" and auth.uid()::text <> old."mentorId";
begin
  if is_admin or is_server then return new; end if;
  if new.paid is distinct from old.paid
     or new."amountCents" is distinct from old."amountCents"
     or new."packageKey" is distinct from old."packageKey"
     or new."stripeSessionId" is distinct from old."stripeSessionId"
     or new."mentorId" is distinct from old."mentorId"
     or new."clientId" is distinct from old."clientId"
     or new."meetingUrl" is distinct from old."meetingUrl"
     or new."meetingRoom" is distinct from old."meetingRoom"
     or new."problemResolvedAt" is distinct from old."problemResolvedAt" then
    raise exception 'This change is not allowed';
  end if;
  if new."startsAt" is distinct from old."startsAt" and (new."startsAt" is null or new."startsAt" <= now()) then
    raise exception 'Session times can only be moved to a time in the future';
  end if;
  if (new."problemReportedAt" is distinct from old."problemReportedAt" or new."problemNote" is distinct from old."problemNote")
     and (not is_client or old."problemReportedAt" is not null) then
    raise exception 'This change is not allowed';
  end if;
  -- only the client confirms the session happened / marks it reviewed: once, and only after its start time
  if (new."clientConfirmedAt" is distinct from old."clientConfirmedAt" and (not is_client or old."clientConfirmedAt" is not null or old."startsAt" is null or old."startsAt" > now()))
     or (new."clientReviewedAt" is distinct from old."clientReviewedAt" and (not is_client or old."clientReviewedAt" is not null or old."startsAt" is null or old."startsAt" > now())) then
    raise exception 'This change is not allowed';
  end if;
  if new."sessionsDone" is distinct from old."sessionsDone" then
    if is_client then raise exception 'Only the mentor can mark sessions done'; end if;
    if coalesce(new."sessionsDone", 0) <> coalesce(old."sessionsDone", 0) + 1
       or old."startsAt" is null or old."startsAt" > now() + interval '15 minutes'
       or coalesce(new."sessionsDone", 0) > public.workar_package_sessions(old."packageKey") then
      raise exception 'A session can be marked done once it has started, one at a time';
    end if;
  end if;
  if is_client then
    if new."proposedTimes" is not null and new."proposedTimes" is distinct from old."proposedTimes" then
      raise exception 'Only the mentor can suggest times';
    end if;
    if new.status is distinct from old.status and new.status <> 'cancelled' then
      if not (old.status = 'pending' and new.status = 'accepted'
              and old."proposedTimes" is not null
              and new."startsAt" = any(old."proposedTimes")
              and new."startsAt" > now()) then
        raise exception 'Only the mentor can accept or decline';
      end if;
    end if;
  end if;
  return new;
end $$;

-- 5 + 6. Checks run through security-definer helpers so the policies don't recurse into each other's RLS
create or replace function public.is_live_mentor(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles m where m.id = p_id and m.role = 'mentor' and m.approved is not false and m.banned is not true)
$$;
create or replace function public.have_booking(p_a text, p_b text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.requests r where (r."mentorId" = p_a and r."clientId" = p_b) or (r."clientId" = p_a and r."mentorId" = p_b))
$$;
create or replace function public.dm_thread_has_sender(p_thread text, p_sender text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.messages where "requestId" = p_thread and "senderId" = p_sender)
$$;
create or replace function public.dm_other(p_thread text, p_me text) returns text
language sql immutable as $$
  select case when split_part(p_thread, '_', 2) = p_me then split_part(p_thread, '_', 3) else split_part(p_thread, '_', 2) end
$$;
revoke all on function public.is_live_mentor(text) from public, anon;
revoke all on function public.have_booking(text, text) from public, anon;
revoke all on function public.dm_thread_has_sender(text, text) from public, anon;
grant execute on function public.is_live_mentor(text) to authenticated;
grant execute on function public.have_booking(text, text) to authenticated;
grant execute on function public.dm_thread_has_sender(text, text) to authenticated;

-- Bookings only with a real, approved mentor
drop policy if exists "client insert requests" on public.requests;
create policy "client insert requests" on public.requests for insert with check (
  (auth.uid())::text = "clientId"
  and "mentorId" is distinct from "clientId"
  and not is_banned((auth.uid())::text)
  and not is_blocked("mentorId", "clientId")
  and public.is_live_mentor("mentorId")
);

-- Direct messages: to an approved mentor, to someone you have a booking with, or replying where they wrote first
drop policy if exists "dm send" on public.messages;
create policy "dm send" on public.messages for insert with check (
  "senderId" = (auth.uid())::text
  and "requestId" like 'dm\_%'
  and not is_banned((auth.uid())::text)
  and "requestId" = 'dm_' || least((auth.uid())::text collate "C", public.dm_other("requestId", (auth.uid())::text) collate "C")
                    || '_' || greatest((auth.uid())::text collate "C", public.dm_other("requestId", (auth.uid())::text) collate "C")
  and public.dm_other("requestId", (auth.uid())::text) <> (auth.uid())::text
  and not is_blocked(split_part("requestId", '_', 2), split_part("requestId", '_', 3))
  and (
    public.is_live_mentor(public.dm_other("requestId", (auth.uid())::text))
    or public.dm_thread_has_sender("requestId", public.dm_other("requestId", (auth.uid())::text))
    or public.have_booking((auth.uid())::text, public.dm_other("requestId", (auth.uid())::text))
    or lower(coalesce(auth.jwt() ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com'
  )
);

-- Follow-up (migration: booking_id_and_session_followup), after an independent re-check:
--  * booking ids may not start with "dm" (a dm_<a>_<b>-shaped booking id linked two strangers in the read rules)
--  * booking ids can't be changed; new bookings need a start time
--  * each session in a package needs its own passed start time ("lastDoneStartsAt" remembers the last one)
alter table public.requests drop constraint if exists requests_id_format;
alter table public.requests add constraint requests_id_format check (id ~ '^[A-Za-z0-9_-]{1,80}$' and id !~* '^dm');
alter table public.requests add column if not exists "lastDoneStartsAt" timestamptz;
-- protect_request(): adds `new.id is distinct from old.id` to the blocked list, requires
--   old."startsAt" > old."lastDoneStartsAt" to mark another session done, and sets new."lastDoneStartsAt" := old."startsAt".
-- protect_request_insert(): rejects a null or past "startsAt" and clears "lastDoneStartsAt".
-- (Full function bodies are in the live database; see pg_proc.)

-- 2026-10-24 (migration: linkedin_verified_flag): profiles."linkedinVerified" (boolean, default false).
-- Set only by the server after "Continue with LinkedIn" (api/agents.js linkedin_photo); protect_profile_approval()
-- resets it on insert and keeps the old value on update for everyone except the admin and the server.

-- 2026-10-24 (migration: session_marks_spacing_and_created_at), after the second re-check:
--  * requests."lastDoneAt": a mentor can mark at most one session done per 12 hours (a reschedule-and-mark
--    loop could mark a whole package done in a minute and unlock the payout)
--  * created_at is set by the database on insert and can't be changed (checkout reads it to decide
--    whether the saved price can be trusted)

-- Oct 24 2026: hygiene from the Supabase security advisor.
alter function public.dm_other(text, text) set search_path = public;
revoke execute on function public.protect_profile_approval() from public, anon, authenticated;
revoke execute on function public.protect_request() from public, anon, authenticated;
revoke execute on function public.protect_request_insert() from public, anon, authenticated;
