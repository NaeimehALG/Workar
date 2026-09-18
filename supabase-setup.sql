-- Run this once in your Supabase project's SQL Editor (Database > SQL Editor > New query)

create table profiles (
  id text primary key,
  role text,
  name text,
  headline text,
  profession text,
  bio text,
  skills text[],
  experience text,
  languages text[],
  linkedin text,
  rate text
);
alter table profiles enable row level security;
create policy "public read profiles" on profiles for select using (true);
create policy "own profile insert" on profiles for insert with check (auth.uid()::text = id);
create policy "own profile update" on profiles for update using (auth.uid()::text = id);

create table reviews (
  id text primary key,
  mentor_id text,
  client_id text,
  rating int,
  text text,
  created_at timestamptz default now()
);
alter table reviews enable row level security;
create policy "public read reviews" on reviews for select using (true);
create policy "own review insert" on reviews for insert with check (auth.uid()::text = client_id);

create table requests (
  id text primary key,
  mentor_id text,
  client_id text,
  message text,
  date text,
  time text,
  status text,
  created_at timestamptz default now()
);
alter table requests enable row level security;
create policy "public read requests" on requests for select using (true);
create policy "client insert requests" on requests for insert with check (auth.uid()::text = client_id);
create policy "mentor update requests" on requests for update using (auth.uid()::text = mentor_id);

-- Payment support: added for the "pay to confirm" + video/voice call features.
-- Column names are camelCase (quoted) to match the field names index.html already writes.
alter table profiles add column if not exists "priceUsd" numeric;
alter table requests add column if not exists "amountCents" integer default 0;
alter table requests add column if not exists paid boolean default false;
alter table requests add column if not exists "stripeSessionId" text;
-- Note: only the Stripe webhook (using your service_role key, never the anon key) is meant
-- to set "paid" and "stripeSessionId" — no client-side RLS policy grants that, by design.
