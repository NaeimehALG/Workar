-- Oct 29 2026: payment / booking safety fixes (applied to the live database with the Supabase MCP, in this order).
-- Applied live: payments_fix_2026_10_29_columns, payments_fix_2026_10_29_protect_request.
-- NOT applied: payments_fix_2026_10_29_insert_and_paid_start (section 3) — the apply was cancelled twice.
--   The code does not need it (the share is locked by the server when the booking is paid; sessions the admin marks
--   without a log entry are treated as approved). Apply it when convenient for defence in depth.

-- ============ 1. payments_fix_2026_10_29_columns ============
alter table public.requests
  add column if not exists "mentorSharePct" numeric,          -- mentor share % locked when the booking is created/paid
  add column if not exists "sessionLog" jsonb,                -- one entry per session marked done: {n, startsAt, markedAt, att?}
  add column if not exists "payoutSessions" integer,          -- sessions already paid to the mentor (per-session payouts)
  add column if not exists "payoutClaimAt" timestamptz,       -- a payout run is working on this booking (double-payout guard)
  add column if not exists "sessionsKept" integer,            -- sessions the client pays for after "Don't charge" / late cancel
  add column if not exists "holdAttempt" integer,             -- card-hold attempt number (unique Stripe idempotency keys)
  add column if not exists "cancelAlertAt" timestamptz,       -- admin was told about a cancellation after the charge
  add column if not exists "paidStartsAt" timestamptz,        -- start time the booking was paid/held for (late-cancel rule)
  add column if not exists "problemSession" integer;          -- which session the open problem report is about

create or replace function public.workar_mentor_share()
returns numeric language sql stable security definer set search_path to 'public' as $$
  select coalesce((select case when (data->>'mentorShare') ~ '^[0-9]+(\.[0-9]+)?$'
                                and (data->>'mentorShare')::numeric > 0 and (data->>'mentorShare')::numeric <= 100
                               then (data->>'mentorShare')::numeric end
                   from public.site_settings where id = 'main'), 70)
$$;

-- existing bookings: the share they were paid with (payoutCents was locked at payment), else today's
update public.requests set "mentorSharePct" = case when "payoutCents" is not null and "amountCents" > 0
    then round("payoutCents"::numeric * 100 / "amountCents", 2) else public.workar_mentor_share() end
  where "mentorSharePct" is null;
update public.requests set "paidStartsAt" = "startsAt" where paid and "paidStartsAt" is null;
-- sessions marked done before today: one log entry each, marked 'legacy' (paid as before, no attendance check)
update public.requests set "sessionLog" = (
    select jsonb_agg(jsonb_build_object('n', g, 'startsAt', coalesce("lastDoneStartsAt", "startsAt"), 'att', jsonb_build_object('status', 'legacy')))
    from generate_series(1, "sessionsDone") g)
  where coalesce("sessionsDone", 0) > 0 and "sessionLog" is null;
-- bookings already paid out in one transfer: everything is paid
update public.requests set "payoutSessions" = public.workar_package_sessions("packageKey")
  where ("payoutDone" or "stripeTransferId" is not null) and "payoutSessions" is null;

-- ============ 2. payments_fix_2026_10_29_protect_request ============
CREATE OR REPLACE FUNCTION public.protect_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  is_admin boolean := coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com';
  is_server boolean := coalesce(auth.role(), '') = 'service_role';
  is_client boolean := auth.uid()::text = old."clientId" and auth.uid()::text <> old."mentorId";
  money_on boolean := coalesce(old.paid, false) or old."holdStatus" in ('saved', 'authorized', 'captured');
  n int;
begin
  if is_admin or is_server then return new; end if;
  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at
     or new.paid is distinct from old.paid
     or new."amountCents" is distinct from old."amountCents"
     or new."packageKey" is distinct from old."packageKey"
     or new."stripeSessionId" is distinct from old."stripeSessionId"
     or new."mentorId" is distinct from old."mentorId"
     or new."clientId" is distinct from old."clientId"
     or new."meetingUrl" is distinct from old."meetingUrl"
     or new."meetingRoom" is distinct from old."meetingRoom"
     or new."problemResolvedAt" is distinct from old."problemResolvedAt"
     or new."mentorSharePct" is distinct from old."mentorSharePct"
     or new."sessionLog" is distinct from old."sessionLog"
     or new."payoutSessions" is distinct from old."payoutSessions"
     or new."payoutClaimAt" is distinct from old."payoutClaimAt"
     or new."sessionsKept" is distinct from old."sessionsKept"
     or new."holdAttempt" is distinct from old."holdAttempt"
     or new."cancelAlertAt" is distinct from old."cancelAlertAt"
     or new."paidStartsAt" is distinct from old."paidStartsAt"
     or new."problemSession" is distinct from old."problemSession" then
    raise exception 'This change is not allowed';
  end if;
  if new.status is distinct from old.status and old.status in ('cancelled', 'declined', 'refunded') then
    raise exception 'A cancelled or declined booking can''t be reopened; please book again';
  end if;
  if new."startsAt" is distinct from old."startsAt" and (new."startsAt" is null or new."startsAt" <= now()) then
    raise exception 'Session times can only be moved to a time in the future';
  end if;
  if is_client and new."startsAt" is distinct from old."startsAt" and old."startsAt" is not null and old."startsAt" <= now() then
    raise exception 'A session time can''t be changed after it has passed';
  end if;
  -- A paid (or card-held) booking: the client can only move the time by accepting one the mentor suggested
  if is_client and money_on and new."startsAt" is distinct from old."startsAt"
     and not (old."proposedTimes" is not null and new."startsAt" = any(old."proposedTimes")) then
    raise exception 'To change the time of a paid session, ask your mentor to suggest new times';
  end if;
  -- Problem reports: the client can report again once the previous report was resolved (one open report at a time)
  if (new."problemReportedAt" is distinct from old."problemReportedAt" or new."problemNote" is distinct from old."problemNote") then
    if not is_client or new."problemReportedAt" is null
       or (old."problemReportedAt" is not null and old."problemResolvedAt" is null)
       or old.status in ('declined', 'refunded') then
      raise exception 'This change is not allowed';
    end if;
    new."problemReportedAt" := now();
    new."problemResolvedAt" := null;
    new."problemSession" := case
      when old."startsAt" is not null and old."startsAt" <= now()
           and (old."lastDoneStartsAt" is null or old."startsAt" > old."lastDoneStartsAt")
        then coalesce(old."sessionsDone", 0) + 1
      else greatest(coalesce(old."sessionsDone", 0), 1) end;
    -- a fresh review for the new report
    new."disputeOpenedAt" := null; new."disputeAnalyzedAt" := null; new."disputeSummary" := null;
    new."disputeRecommendation" := null; new."disputeEvidence" := null;
  end if;
  if (new."clientConfirmedAt" is distinct from old."clientConfirmedAt" and (not is_client or old."clientConfirmedAt" is not null or old."startsAt" is null or old."startsAt" > now()))
     or (new."clientReviewedAt" is distinct from old."clientReviewedAt" and (not is_client or old."clientReviewedAt" is not null or old."startsAt" is null or old."startsAt" > now())) then
    raise exception 'This change is not allowed';
  end if;
  if new."sessionsDone" is distinct from old."sessionsDone" then
    if is_client then raise exception 'Only the mentor can mark sessions done'; end if;
    -- only after the session's start has actually passed (no early marking), one per 12 hours, each with its own time
    if coalesce(new."sessionsDone", 0) <> coalesce(old."sessionsDone", 0) + 1
       or old.status is distinct from 'accepted'
       or old."startsAt" is null or old."startsAt" > now()
       or (old."lastDoneStartsAt" is not null and old."startsAt" <= old."lastDoneStartsAt")
       or (old."lastDoneAt" is not null and old."lastDoneAt" > now() - interval '12 hours')
       or coalesce(new."sessionsDone", 0) > public.workar_package_sessions(old."packageKey") then
      raise exception 'Mark a session done after it has started; one session per 12 hours, each with its own time';
    end if;
    n := coalesce(new."sessionsDone", 0);
    new."lastDoneStartsAt" := old."startsAt";
    new."lastDoneAt" := now();
    new."sessionLog" := coalesce(old."sessionLog", '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('n', n, 'startsAt', old."startsAt", 'markedAt', now()));
  else
    new."lastDoneStartsAt" := old."lastDoneStartsAt";
    new."lastDoneAt" := old."lastDoneAt";
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
end $function$;

-- ============ 3. payments_fix_2026_10_29_insert_and_paid_start (NOT APPLIED YET) ============
CREATE OR REPLACE FUNCTION public.protect_request_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com'
     or coalesce(auth.role(), '') = 'service_role' then
    if new."mentorSharePct" is null then new."mentorSharePct" := public.workar_mentor_share(); end if;
    return new;
  end if;
  if new."startsAt" is null or new."startsAt" <= now() then
    raise exception 'Please pick a time in the future';
  end if;
  new.created_at := now();
  new."packageKey" := case when new."packageKey" in ('single','resume','interview','offer') then new."packageKey" else 'single' end;
  new."amountCents" := public.workar_price_cents(new."mentorId", new."packageKey");
  new.paid := false; new."stripeSessionId" := null; new.status := 'pending'; new."sessionsDone" := 0;
  new."payoutDone" := false; new."payoutAt" := null; new."payoutCents" := null; new."stripeChargeId" := null;
  new."stripeTransferId" := null; new."payoutError" := null; new."payoutNudgedAt" := null;
  new."meetingUrl" := null; new."meetingRoom" := null; new."prepBrief" := null; new."remindedAt" := null;
  new."followupSentAt" := null; new."nudgedAt" := null; new."proposedTimes" := null;
  new."problemReportedAt" := null; new."problemNote" := null; new."problemResolvedAt" := null;
  new."clientConfirmedAt" := null; new."clientReviewedAt" := null;
  new."disputeOpenedAt" := null; new."disputeAnalyzedAt" := null; new."disputeSummary" := null;
  new."disputeRecommendation" := null; new."disputeEvidence" := null; new."lastDoneStartsAt" := null; new."lastDoneAt" := null;
  -- money fields: managed by Workar only; the mentor's share is locked now
  new."mentorSharePct" := public.workar_mentor_share();
  new."sessionLog" := null; new."payoutSessions" := null; new."payoutClaimAt" := null; new."sessionsKept" := null;
  new."holdAttempt" := null; new."cancelAlertAt" := null; new."paidStartsAt" := null; new."problemSession" := null;
  return new;
end $function$;

-- The start time a booking was paid/held for (late cancellation is measured against it).
-- Runs for everyone, after the protect_* triggers (alphabetical order).
--   becomes paid → the current start
--   an agreed move (mentor/admin, or the client accepting a suggested time) → the new start, but a move to less than
--     24 hours away keeps the later of the two times, so a mentor's late move never makes the client's cancel "late"
--   only the server/admin can set it directly
create or replace function public.workar_paid_start()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  privileged boolean := coalesce(auth.role(), '') = 'service_role' or coalesce(lower(auth.jwt() ->> 'email'), '') = 'naeimeh.alaghehband@gmail.com';
begin
  if new."paidStartsAt" is distinct from old."paidStartsAt" and not privileged then
    new."paidStartsAt" := old."paidStartsAt";
  end if;
  if coalesce(new.paid, false) and (not coalesce(old.paid, false) or new."paidStartsAt" is null) then
    new."paidStartsAt" := new."startsAt";
  elsif coalesce(new.paid, false) and new."startsAt" is distinct from old."startsAt" and new."startsAt" is not null then
    new."paidStartsAt" := case when new."startsAt" - now() >= interval '24 hours' then new."startsAt"
                               else greatest(coalesce(old."paidStartsAt", old."startsAt"), new."startsAt") end;
  end if;
  return new;
end $$;
drop trigger if exists workar_paid_start on public.requests;
create trigger workar_paid_start before update on public.requests for each row execute function public.workar_paid_start();

-- Sessions marked done by the admin (or the server) skip protect_request; log them too, so they can be paid.
create or replace function public.workar_session_log()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
declare k int;
begin
  if coalesce(new."sessionsDone", 0) > coalesce(old."sessionsDone", 0) then
    for k in (coalesce(old."sessionsDone", 0) + 1)..coalesce(new."sessionsDone", 0) loop
      if not exists (select 1 from jsonb_array_elements(coalesce(new."sessionLog", '[]'::jsonb)) e where (e->>'n')::int = k) then
        new."sessionLog" := coalesce(new."sessionLog", '[]'::jsonb)
          || jsonb_build_array(jsonb_build_object('n', k, 'startsAt', old."startsAt", 'markedAt', now(), 'by', 'admin'));
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists workar_session_log on public.requests;
create trigger workar_session_log before update on public.requests for each row execute function public.workar_session_log();
