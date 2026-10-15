-- Resumes and chat attachments. Run once in Supabase → SQL Editor.
-- Files live in a private bucket under <owner id>/...; a file can be opened by its owner,
-- the Workar admin, and people the owner has a booking or a conversation with.

alter table public.profiles add column if not exists "resumePath" text;
alter table public.profiles add column if not exists "resumeName" text;
alter table public.messages add column if not exists attachment jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 10485760, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'image/png', 'image/jpeg', 'image/webp'
])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "files upload own folder" on storage.objects;
create policy "files upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "files delete own" on storage.objects;
create policy "files delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "files read shared" on storage.objects;
create policy "files read shared" on storage.objects for select to authenticated using (
  bucket_id = 'files' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com'
    or exists (
      select 1 from public.requests r
      where (r."mentorId" = (select auth.uid())::text and r."clientId" = (storage.foldername(name))[1])
         or (r."clientId" = (select auth.uid())::text and r."mentorId" = (storage.foldername(name))[1])
    )
    or exists (
      select 1 from public.messages m
      where m."requestId" = 'dm_' || least((select auth.uid())::text collate "C", (storage.foldername(name))[1] collate "C")
                           || '_' || greatest((select auth.uid())::text collate "C", (storage.foldername(name))[1] collate "C")
    )
  )
);
