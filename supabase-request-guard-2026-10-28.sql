-- Oct 28 2026: two more limits in protect_request (applied to the live database).
--  1. A client can't move a session time once that time has passed (it would delay the charge after a session that happened).
--  2. Nobody but the admin or the server can reopen a cancelled, declined or refunded booking (it could get a client charged).
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
     or new."problemResolvedAt" is distinct from old."problemResolvedAt" then
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
  if (new."problemReportedAt" is distinct from old."problemReportedAt" or new."problemNote" is distinct from old."problemNote")
     and (not is_client or old."problemReportedAt" is not null) then
    raise exception 'This change is not allowed';
  end if;
  if (new."clientConfirmedAt" is distinct from old."clientConfirmedAt" and (not is_client or old."clientConfirmedAt" is not null or old."startsAt" is null or old."startsAt" > now()))
     or (new."clientReviewedAt" is distinct from old."clientReviewedAt" and (not is_client or old."clientReviewedAt" is not null or old."startsAt" is null or old."startsAt" > now())) then
    raise exception 'This change is not allowed';
  end if;
  if new."sessionsDone" is distinct from old."sessionsDone" then
    if is_client then raise exception 'Only the mentor can mark sessions done'; end if;
    if coalesce(new."sessionsDone", 0) <> coalesce(old."sessionsDone", 0) + 1
       or old."startsAt" is null or old."startsAt" > now() + interval '15 minutes'
       or (old."lastDoneStartsAt" is not null and old."startsAt" <= old."lastDoneStartsAt")
       or (old."lastDoneAt" is not null and old."lastDoneAt" > now() - interval '12 hours')
       or coalesce(new."sessionsDone", 0) > public.workar_package_sessions(old."packageKey") then
      raise exception 'Mark a session done after it has started; one session per 12 hours, each with its own time';
    end if;
    new."lastDoneStartsAt" := old."startsAt";
    new."lastDoneAt" := now();
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
