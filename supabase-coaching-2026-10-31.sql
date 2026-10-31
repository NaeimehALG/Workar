-- Career & life coaching (applied 2026-10-31): a mentor may list an ICF credential level.
-- Self-reported; the profile links to ICF's public verification page.
alter table public.profiles add column if not exists "coachIcf" text;
alter table public.profiles drop constraint if exists profiles_coach_icf_check;
alter table public.profiles add constraint profiles_coach_icf_check check ("coachIcf" is null or "coachIcf" in ('ACC','PCC','MCC'));
