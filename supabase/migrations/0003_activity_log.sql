-- ============================================================
-- Dziennik zmian `activity_log` — patrz CLAUDE.md, sekcja "Audit trail": insert-only, REALNY diff
-- pól (`before`/`after` jako jsonb), aktor = zalogowany użytkownik (e-mail) LUB `bot:<źródło>`.
-- Świadomie inaczej niż logChange() w Panelu floty (tam tylko opis zdarzenia bez wartości — po
-- incydencie z utraconymi danymi nie dało się ustalić, co zginęło).
--
-- Zapis idzie TRIGGEREM na `loads`, nie z kodu appki: od kiedy każda komórka Zestawienia jest
-- edytowalna inline, a rekordy da się dopinać i usuwać, jedyny sposób, żeby NIC nie umknęło, to
-- logować w bazie — niezależnie od tego, którą ścieżką (import, "Dopnij PDF", Enter w komórce,
-- "Usuń", w przyszłości bot z kluczem service_role) zmiana weszła.
--
-- Odpalić RĘCZNIE w SQL Editor projektu Grabowskiego, PO 0001 i 0002. Potem odświeżyć cache
-- PostgREST (NOTIFY pgrst, 'reload schema' / przycisk "Reload schema cache") — jak przy każdej
-- ręcznej migracji, inaczej appka nie zobaczy nowej tabeli.
-- ============================================================

create table if not exists public.activity_log (
  id            uuid primary key default gen_random_uuid(),
  -- Bez klucza obcego do loads: usunięcie zlecenia ma ZOSTAWIĆ jego historię (FK z cascade by ją
  -- skasował, z set null by zerwał powiązanie). order_number to migawka do czytania po usunięciu.
  load_id       uuid,
  order_number  text,
  action        text not null check (action in ('insert', 'update', 'delete')),
  before        jsonb,   -- update: tylko zmienione pola (stare wartości); delete: cały rekord
  after         jsonb,   -- update: tylko zmienione pola (nowe wartości); insert: cały rekord
  actor         text not null,  -- e-mail użytkownika albo 'bot:<źródło>'
  actor_id      uuid,           -- auth.uid(), null dla botów
  created_at    timestamptz not null default now()
);

alter table public.activity_log enable row level security;

-- Insert-only dla klienta: jest SELECT i INSERT, NIE MA polityk update/delete — nikt z appki nie
-- poprawi ani nie wyczyści historii. (Klucz service_role omija RLS — to świadome, do administracji.)
drop policy if exists "wymaga logowania - odczyt" on public.activity_log;
create policy "wymaga logowania - odczyt"
on public.activity_log for select to authenticated using (true);

drop policy if exists "wymaga logowania - dopisywanie" on public.activity_log;
create policy "wymaga logowania - dopisywanie"
on public.activity_log for insert to authenticated with check (true);

create index if not exists activity_log_load_id_created_at_idx on public.activity_log (load_id, created_at desc);
create index if not exists activity_log_created_at_idx on public.activity_log (created_at desc);

-- Aktor: (1) jawnie ustawiony przez bota w tej samej transakcji:
--   select set_config('app.actor', 'bot:e-brama-scraper', true);
-- (2) e-mail zalogowanego użytkownika z JWT, (3) awaryjnie 'bot:<rola>' (np. bot:service_role).
create or replace function public.log_loads_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    text := coalesce(
    nullif(current_setting('app.actor', true), ''),
    auth.jwt() ->> 'email',
    'bot:' || coalesce(auth.role(), 'unknown')
  );
  v_actor_id uuid := auth.uid();
  v_old      jsonb;
  v_new      jsonb;
  v_before   jsonb := '{}'::jsonb;
  v_after    jsonb := '{}'::jsonb;
  v_key      text;
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (load_id, order_number, action, before, after, actor, actor_id)
    values (new.id, new.order_number, 'insert', null, to_jsonb(new) - 'created_at' - 'updated_at', v_actor, v_actor_id);
    return null;
  end if;

  if tg_op = 'DELETE' then
    insert into public.activity_log (load_id, order_number, action, before, after, actor, actor_id)
    values (old.id, old.order_number, 'delete', to_jsonb(old) - 'created_at' - 'updated_at', null, v_actor, v_actor_id);
    return null;
  end if;

  -- UPDATE: tylko pola, które faktycznie się zmieniły (updated_at zmienia się zawsze — pomijamy).
  v_old := to_jsonb(old) - 'updated_at';
  v_new := to_jsonb(new) - 'updated_at';
  for v_key in select key from jsonb_each(v_new) loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after  := v_after  || jsonb_build_object(v_key, v_new -> v_key);
    end if;
  end loop;
  if v_after = '{}'::jsonb then
    return null; -- UPDATE bez realnej zmiany (np. Enter na tej samej wartości) — nie zaśmiecamy dziennika
  end if;

  insert into public.activity_log (load_id, order_number, action, before, after, actor, actor_id)
  values (new.id, new.order_number, 'update', v_before, v_after, v_actor, v_actor_id);
  return null;
end;
$$;

drop trigger if exists loads_activity_log on public.loads;
create trigger loads_activity_log
after insert or update or delete on public.loads
for each row execute function public.log_loads_activity();

-- Panel "Historia" w Zestawieniu czyta dziennik na żywo (postgres_changes INSERT).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_log'
  ) then
    alter publication supabase_realtime add table public.activity_log;
  end if;
end $$;
