-- Enduro Crono · profili con avatar
-- Da incollare in Supabase > SQL Editor > Run. Si può rilanciare senza danni.

-- 1) Indirizzo della foto profilo (Google o caricata dall'app)
alter table public.profiles add column if not exists avatar_url text;

-- 2) Spazio "avatars" per le foto: visibili a tutti (come l'avatar di un social),
--    ognuno può caricare/cambiare/togliere solo la propria, nella cartella col proprio id.
--    Limite 1 MB, solo immagini (l'app le rimpicciolisce a 256 px prima di inviarle).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 1048576,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists ec_avatars_insert_own on storage.objects;
create policy ec_avatars_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists ec_avatars_update_own on storage.objects;
create policy ec_avatars_update_own on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists ec_avatars_delete_own on storage.objects;
create policy ec_avatars_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- serve anche la lettura per sovrascrivere (upsert) la propria foto
drop policy if exists ec_avatars_select_own on storage.objects;
create policy ec_avatars_select_own on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 3) Controllo: deve comparire il bucket avatars e le 4 regole ec_avatars_*
select 'bucket' as tipo, id || ' public=' || public as dettaglio from storage.buckets where id = 'avatars'
union all
select 'regola', policyname || ' [' || cmd || ']' from pg_policies where schemaname = 'storage' and policyname like 'ec_avatars%';
