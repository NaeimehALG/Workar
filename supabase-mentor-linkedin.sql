-- Mentors must have a personal LinkedIn profile (linkedin.com/in/<name>) to be approved or stay approved.
-- Applies to everyone, including the admin's manual "Approve" button and the daily AI review.
-- Not applied yet: run once in Supabase → SQL Editor to also block manual approval without LinkedIn.
create or replace function public.require_mentor_linkedin()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $function$
begin
  if new.role = 'mentor' and new.approved is true
     and coalesce(new.linkedin, '') !~* '^(https?://)?([a-z]{2,3}\.|www\.)?linkedin\.com/in/[^/?#[:space:]]{3,100}/?([?#].*)?$' then
    raise exception 'A mentor needs a personal LinkedIn profile link (linkedin.com/in/...) to be approved.'
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;

drop trigger if exists require_mentor_linkedin on public.profiles;
create trigger require_mentor_linkedin
  before insert or update on public.profiles
  for each row execute function public.require_mentor_linkedin();
