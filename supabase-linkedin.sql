-- LinkedIn posts queued by the weekly content task and sent to Typefully by the daily cron (api/_linkedin.js).
-- Applied to the live database on 15 Oct 2026.
create table if not exists public.linkedin_queue (
  id text primary key,
  "publishAt" timestamptz not null,
  text text not null,
  "imageUrl" text,
  "altText" text,
  format text,
  status text not null default 'queued',
  "typefullyDraftId" text,
  error text,
  "createdAt" timestamptz not null default now(),
  "sentAt" timestamptz
);
alter table public.linkedin_queue enable row level security;
