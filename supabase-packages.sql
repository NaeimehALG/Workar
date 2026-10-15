-- Mentor-written package contents (what each package includes), shown on the mentor's page.
-- Applied to the live database on 15 Oct 2026.
alter table public.profiles add column if not exists "packageNotes" jsonb;
