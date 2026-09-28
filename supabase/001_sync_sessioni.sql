-- Enduro Crono · sincronizzazione sessioni
-- Da incollare in Supabase > SQL Editor > Run. Si può rilanciare senza danni.

-- 1) Colonne per salvare la sessione intera (enduro e motocross con manche)
alter table public.sessions
  add column if not exists mode    text    not null default 'enduro',
  add column if not exists data    jsonb,
  add column if not exists deleted boolean not null default false;

do $$ begin
  alter table public.sessions add constraint sessions_mode_check check (mode in ('enduro', 'mx'));
exception when duplicate_object then null; end $$;

alter table public.sessions alter column owner set default auth.uid();
create index if not exists sessions_owner_idx on public.sessions (owner);

-- 2) Regole di accesso: ognuno legge e scrive solo le proprie sessioni
--    (eseguito il 2026-09-28: queste ec_* doppiano le regole già presenti sessions_read/insert/update, innocue)
alter table public.sessions enable row level security;

drop policy if exists ec_sessions_select_own on public.sessions;
create policy ec_sessions_select_own on public.sessions
  for select to authenticated using (owner = (select auth.uid()));

drop policy if exists ec_sessions_insert_own on public.sessions;
create policy ec_sessions_insert_own on public.sessions
  for insert to authenticated with check (owner = (select auth.uid()));

drop policy if exists ec_sessions_update_own on public.sessions;
create policy ec_sessions_update_own on public.sessions
  for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- 3) Controllo finale: il risultato serve a Claude per verificare che tutto torni
select 'colonna' as tipo,
       column_name || ' ' || data_type || case when is_nullable = 'NO' then ' NOT NULL' else '' end
         || coalesce(' default ' || column_default, '') as dettaglio
  from information_schema.columns where table_schema = 'public' and table_name = 'sessions'
union all
select 'vincolo', conname || ': ' || pg_get_constraintdef(oid)
  from pg_constraint where conrelid = 'public.sessions'::regclass
union all
select 'regola', policyname || ' [' || cmd || '] ' || coalesce(qual, '') || ' / ' || coalesce(with_check, '')
  from pg_policies where schemaname = 'public' and tablename = 'sessions'
union all
select 'profilo', column_name || ' ' || data_type || case when is_nullable = 'NO' then ' NOT NULL' else '' end
         || coalesce(' default ' || column_default, '')
  from information_schema.columns where table_schema = 'public' and table_name = 'profiles'
union all
select 'trigger nuovi utenti', tgname
  from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
