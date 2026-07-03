-- Adds support for a per-session custom fact theme (e.g. "space facts", "movie trivia")
-- that replaces the app's default hardcoded animal facts when set.
alter table public.sessions
  add column if not exists fact_theme text,
  add column if not exists custom_facts jsonb,
  add column if not exists facts_status text not null default 'none';

alter table public.sessions
  drop constraint if exists sessions_facts_status_check;

alter table public.sessions
  add constraint sessions_facts_status_check
  check (facts_status in ('none', 'pending', 'ready', 'error'));

-- Ensure realtime UPDATE events on sessions reach clients, mirroring spotted_plates
-- which is already in the publication (used by subscribeToPlates in index.html).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sessions'
  ) then
    alter publication supabase_realtime add table public.sessions;
  end if;
end $$;
