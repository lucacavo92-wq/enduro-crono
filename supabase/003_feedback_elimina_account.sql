-- Enduro Crono · commenti dei tester ed eliminazione dell'account (GDPR)
-- Da incollare in Supabase > SQL Editor > Run. Si può rilanciare senza danni.

-- 1) Commenti inviati dall'app: chiunque può scriverne uno, nessuno può leggerli dall'app
--    (li legge solo il proprietario dal pannello di Supabase o Claude con il connettore).
create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete set null default auth.uid(),
  message     text not null check (char_length(message) between 1 and 4000),
  app_version text,
  device      text,
  page        text
);
alter table public.feedback enable row level security;

drop policy if exists ec_feedback_insert on public.feedback;
create policy ec_feedback_insert on public.feedback for insert to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));

grant insert on public.feedback to anon, authenticated;

-- 2) "Elimina il mio account": cancella l'utente; a cascata spariscono profilo e sessioni online.
--    La foto profilo la toglie l'app prima (API di Storage). Gira con i permessi del proprietario
--    ma agisce solo sull'utente che la chiama.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'non autenticato'; end if;
  delete from auth.users where id = me;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- 3) Controllo
select 'tabella' as tipo, 'feedback' as dettaglio where to_regclass('public.feedback') is not null
union all
select 'funzione', 'delete_my_account' where to_regprocedure('public.delete_my_account()') is not null;
