-- 2026-10-29: hourly setup sweep. Supabase calls https://workar.me/api/reminders?task=setup_sweep every hour,
-- so about an hour after someone signs up without finishing their profile they get the setup email
-- (see setupSweep in api/_autopilot.js). The key is kept in Supabase Vault and in Vercel as SETUP_SWEEP_KEY.
-- To change the key: update the Vault secret "setup_sweep_key" and the Vercel variable to the same value.
create extension if not exists pg_net;
create extension if not exists pg_cron;
-- select vault.create_secret('<key>', 'setup_sweep_key');   -- done once, the value is not kept in this file
select cron.unschedule('workar-setup-sweep') where exists (select 1 from cron.job where jobname = 'workar-setup-sweep');
select cron.schedule('workar-setup-sweep', '7 * * * *', $$
  select net.http_get(
    url := 'https://workar.me/api/reminders?task=setup_sweep',
    headers := jsonb_build_object('x-sweep-key', (select decrypted_secret from vault.decrypted_secrets where name = 'setup_sweep_key' limit 1)),
    timeout_milliseconds := 120000
  );
$$);
