-- Privacy: who can read a profile.
-- Approved mentor profiles stay public (people browse and book them). Everyone else's profile
-- (clients, mentors waiting for approval) is visible only to themselves, the Workar admin, and
-- people they have a booking or a conversation with. Run once in Supabase → SQL Editor.

alter policy "public read profiles" on public.profiles using (
  (role = 'mentor' and approved is not false)
  or id = (auth.uid())::text
  or lower(coalesce(auth.jwt() ->> 'email', '')) = 'naeimeh.alaghehband@gmail.com'
  or exists (
    select 1 from public.requests r
    where (r."mentorId" = (auth.uid())::text and r."clientId" = profiles.id)
       or (r."clientId" = (auth.uid())::text and r."mentorId" = profiles.id)
  )
  or exists (
    select 1 from public.messages m
    where m."requestId" = 'dm_' || least((auth.uid())::text collate "C", profiles.id collate "C")
                         || '_' || greatest((auth.uid())::text collate "C", profiles.id collate "C")
  )
);

-- Reviews show the reviewer's first name and last initial (e.g. "Arash E."), never the full profile.
create or replace function public.reviewer_names(ids text[])
returns table (id text, name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id,
         trim(split_part(trim(p.name), ' ', 1) || ' ' ||
              coalesce(nullif(left(split_part(trim(p.name), ' ', 2), 1), '') || '.', '')) as name
  from public.profiles p
  where p.id = any(ids)
    and exists (select 1 from public.reviews r where r."clientId" = p.id and coalesce(r.hidden, false) = false)
$$;
grant execute on function public.reviewer_names(text[]) to anon, authenticated;
