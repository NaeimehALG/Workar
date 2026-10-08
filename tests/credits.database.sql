-- Run ONLY against a disposable PostgreSQL database:
-- psql "$WORKAR_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/credits.database.sql
-- The production schema must be inspected separately before applying migration.
create role anon;
create role authenticated;
create role service_role;
create table public.profiles (id text primary key, "aiCredits" integer);
\ir ../supabase/migrations/202610080001_atomic_ai_credits.sql
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.profiles (id, "aiCredits") values ('credit-test', 5), ('null-test', null);
do $$
declare result jsonb; balance integer;
begin
  result := public.grant_ai_credit_purchase('cs_first', 'credit-test', 20);
  if result->>'applied' <> 'true' then raise exception 'first purchase not applied'; end if;
  result := public.grant_ai_credit_purchase('cs_first', 'credit-test', 20);
  if result->>'applied' <> 'false' then raise exception 'duplicate applied'; end if;
  select "aiCredits" into balance from public.profiles where id = 'credit-test';
  if balance <> 25 then raise exception 'duplicate changed balance'; end if;
  perform public.grant_ai_credit_purchase('cs_second', 'credit-test', 20);
  if public.consume_ai_credit('credit-test') <> 44 then raise exception 'debit overwrote purchase'; end if;
  perform public.grant_ai_credit_purchase('cs_null', 'null-test', 20);
  select "aiCredits" into balance from public.profiles where id = 'null-test';
  if balance <> 25 then raise exception 'starter credits lost'; end if;

  begin
    perform public.grant_ai_credit_purchase('cs_first', 'null-test', 20);
    raise exception 'expected-mismatch-error';
  exception when others then
    if sqlerrm <> 'credit-purchase-mismatch' then raise; end if;
  end;
  begin
    perform public.grant_ai_credit_purchase('cs_missing', 'missing-user', 20);
    raise exception 'expected-missing-profile-error';
  exception when others then
    if sqlerrm <> 'credit-profile-missing' then raise; end if;
  end;
  if exists(select 1 from public.ai_credit_purchases where stripe_session_id='cs_missing') then
    raise exception 'failed purchase left receipt behind';
  end if;
  insert into public.profiles (id, "aiCredits") values ('missing-user', 5);
  result := public.grant_ai_credit_purchase('cs_missing', 'missing-user', 20);
  if result->>'applied' <> 'true' then raise exception 'retry blocked after rollback'; end if;

  update public.profiles set "aiCredits" = 0 where id = 'credit-test';
  if public.consume_ai_credit('credit-test') is not null then raise exception 'zero balance debited'; end if;
  if has_function_privilege('authenticated', 'public.grant_ai_credit_purchase(text,text,integer)', 'execute')
     or has_function_privilege('anon', 'public.consume_ai_credit(text)', 'execute')
     or has_table_privilege('authenticated', 'public.ai_credit_purchases', 'insert') then
    raise exception 'client role can grant credits';
  end if;
  if not has_function_privilege('service_role', 'public.grant_ai_credit_purchase(text,text,integer)', 'execute') then
    raise exception 'server cannot grant credits';
  end if;
end;
$$;
rollback;
