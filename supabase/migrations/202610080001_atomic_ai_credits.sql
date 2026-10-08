begin;

-- Install before deploying the webhook. Reconcile already fulfilled Stripe
-- purchases into this ledger first; replaying pre-migration purchases otherwise
-- cannot be distinguished from purchases never fulfilled by the old endpoint.
create table public.ai_credit_purchases (
  stripe_session_id text primary key check (length(stripe_session_id) > 0),
  user_id text not null check (length(user_id) > 0),
  credits integer not null check (credits > 0 and credits <= 10000),
  fulfilled_at timestamptz not null default now()
);
alter table public.ai_credit_purchases enable row level security;
revoke all on public.ai_credit_purchases from public, anon, authenticated;
grant all on public.ai_credit_purchases to service_role;

create function public.grant_ai_credit_purchase(
  p_session_id text, p_user_id text, p_credits integer
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  inserted_count integer;
  purchase public.ai_credit_purchases%rowtype;
  balance integer;
begin
  if p_session_id is null or length(p_session_id) = 0
     or p_user_id is null or length(p_user_id) = 0
     or p_credits is null or p_credits <= 0 or p_credits > 10000 then
    raise exception 'invalid-credit-purchase';
  end if;

  -- The unique key serializes simultaneous callbacks for the same purchase.
  -- This insert rolls back if the profile update fails, so retries remain safe.
  insert into public.ai_credit_purchases (stripe_session_id, user_id, credits)
  values (p_session_id, p_user_id, p_credits)
  on conflict (stripe_session_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    select * into purchase from public.ai_credit_purchases
    where stripe_session_id = p_session_id;
    if purchase.user_id <> p_user_id or purchase.credits <> p_credits then
      raise exception 'credit-purchase-mismatch';
    end if;
    return jsonb_build_object('applied', false);
  end if;

  -- Match the five free starter credits used by the AI endpoint.
  update public.profiles
  set "aiCredits" = coalesce("aiCredits", 5) + p_credits
  where id::text = p_user_id
  returning "aiCredits" into balance;
  if not found then raise exception 'credit-profile-missing'; end if;
  return jsonb_build_object('applied', true, 'aiCreditsRemaining', balance);
end;
$$;

-- Additive grants must not be overwritten by an in-flight AI reply.
create function public.consume_ai_credit(p_user_id text)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare balance integer;
begin
  update public.profiles
  set "aiCredits" = coalesce("aiCredits", 5) - 1
  where id::text = p_user_id and coalesce("aiCredits", 5) > 0
  returning "aiCredits" into balance;
  return balance;
end;
$$;

revoke all on function public.grant_ai_credit_purchase(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.consume_ai_credit(text)
  from public, anon, authenticated;
grant execute on function public.grant_ai_credit_purchase(text, text, integer) to service_role;
grant execute on function public.consume_ai_credit(text) to service_role;
notify pgrst, 'reload schema';
commit;
