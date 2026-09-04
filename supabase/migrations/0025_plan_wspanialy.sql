-- ============================================================
-- 0025 — "Plan wspaniały": rozstawienie kontenerów na pojazdach.
--
-- Widok planu NIE jest osobnym zbiorem danych — to ten sam `loads` pokazany inaczej (właściciel:
-- "jedno wynika z drugiego, więc zmiany w jednym wpływają automatycznie na drugie"). Zlecenie samo
-- niesie już pojazd (`vehicle_plate`), kierowcę i datę; planowi brakowało tylko JEDNEJ informacji:
-- w którym miejscu zestawu kontener stoi. Stąd `plan_slot` na `loads`, a nie osobna tabela
-- przypisań — inaczej ta sama prawda leżałaby w dwóch miejscach i rozjechałaby się przy pierwszej
-- edycji w Zestawieniu.
--
-- Dwa sloty, bo 90% pracy to łączenie dwóch kontenerów 20-stopowych na jednym zestawie:
--   'tyl'   — tył naczepy / przyczepa,
--   'przod' — przód naczepy / solówka.
-- Kontener 40/45 zajmuje CAŁY zestaw. Nie ma na to trzeciej wartości: rozmiar zna kolumna
-- `container_size` i to ona zostaje źródłem prawdy (appka scala wtedy obie kolumny wiersza).
-- Zlecenie zajmujące cały zestaw zapisujemy jako 'tyl' — appka normalizuje to przy zapisie.
--
-- `plan_prev_note` — dolna linia kafelka eksportu ("po jakim imporcie jest ten kontener").
-- Appka wylicza ją z planu (poprzedni import tego pojazdu), ale właściciel wprost poprosił
-- o możliwość nadpisania ręcznego — na starcie wdrożenia poprzednie dni nie są w appce zaplanowane,
-- więc nie ma z czego wyliczać.
-- ============================================================

alter table public.loads
  add column if not exists plan_slot text,
  add column if not exists plan_prev_note text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'loads_plan_slot_check'
  ) then
    alter table public.loads
      add constraint loads_plan_slot_check check (plan_slot in ('tyl', 'przod'));
  end if;
end $$;

comment on column public.loads.plan_slot is
  'Miejsce na zestawie w Planie wspaniałym: tyl (tył naczepy/przyczepa) albo przod (przód naczepy/solówka). Kontener 40/45 zajmuje oba miejsca — zapisywany jako tyl.';
comment on column public.loads.plan_prev_note is
  'Ręczne nadpisanie linii "po jakim imporcie" w kafelku eksportu. Puste = appka wylicza z planu.';

-- Plan czyta po pojeździe i dniu — bez tego indeksu każde przewinięcie dnia to skan całej tabeli.
create index if not exists loads_plan_lookup_idx
  on public.loads (vehicle_plate, load_date, direction);

-- ============================================================
-- plan_vehicles — wiersze planu.
--
-- Lista pojazdów pochodzi z Panelu floty (`fleet_store.vehicles`, ciągniki i solówki) i to ona
-- zostaje źródłem prawdy o tym, JAKIE auta w ogóle są. Ta tabela dokłada tylko to, czego Panel
-- floty NIE MA, a plan potrzebuje:
--   * `driver_name` — Panel floty nie wiąże kierowcy z pojazdem (sprawdzone: rekord pojazdu nie ma
--     takiego pola). Kierowca "etatowy" tego auta; wstawiany na zlecenie przy upuszczeniu na wiersz.
--   * `payload_kg` — ładowność. Właściciel zapowiedział dodanie tego pola w Panelu floty; do tego
--     czasu wpisuje się je tutaj. Gdy pole we flocie się pojawi, appka bierze wartość stamtąd,
--     a ta zostaje jako nadpisanie.
--   * `position`/`hidden` — kolejność wierszy i ukrycie auta, którego dyspozytor nie planuje.
-- Wiersz powstaje dopiero, gdy ktoś coś ustawi (upsert po tablicy) — pusty plan nie zakłada 40
-- wierszy śmieci.
-- ============================================================

create table if not exists public.plan_vehicles (
  vehicle_plate text primary key,
  driver_name text,
  payload_kg numeric,
  position integer,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.plan_vehicles is
  'Dane wiersza Planu wspaniałego, których nie ma Panel floty: kierowca etatowy, ładowność, kolejność.';

-- ============================================================
-- plan_absences — "auto dziś nie jeździ".
--
-- Właściciel: wiersze planu to wszystkie auta, "ale pozostawiając opcję wpisania urlopu (połączony
-- z panelem floty)". Urlopy kierowców SĄ w Panelu floty (`drivers[].vacations` = [{startDate,
-- endDate}]) i appka je czyta — ale NIGDY tam nie pisze (źródłem prawdy zostaje Panel floty), a
-- nieobecność bywa też sprawą samego auta (awaria, serwis, kierowca spoza floty). Stąd własna
-- tabela obok, a nie zamiast.
-- ============================================================

create table if not exists public.plan_absences (
  id uuid primary key default gen_random_uuid(),
  vehicle_plate text not null,
  start_date date not null,
  end_date date not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint plan_absences_range_check check (end_date >= start_date)
);

create index if not exists plan_absences_lookup_idx
  on public.plan_absences (vehicle_plate, start_date, end_date);

comment on table public.plan_absences is
  'Nieobecność pojazdu w planie (urlop, awaria, serwis). Urlopy kierowców z Panelu floty czytamy osobno i tylko do odczytu.';

-- Wzorzec "wymaga logowania" z reszty appki: tylko `authenticated`, nigdy `anon`.
alter table public.plan_vehicles enable row level security;
alter table public.plan_absences enable row level security;

drop policy if exists "plan_vehicles - wymaga logowania" on public.plan_vehicles;
create policy "plan_vehicles - wymaga logowania"
  on public.plan_vehicles for all
  to authenticated
  using (true) with check (true);

drop policy if exists "plan_absences - wymaga logowania" on public.plan_absences;
create policy "plan_absences - wymaga logowania"
  on public.plan_absences for all
  to authenticated
  using (true) with check (true);

grant select, insert, update, delete on public.plan_vehicles to authenticated;
grant select, insert, update, delete on public.plan_absences to authenticated;

-- `updated_at` — ten sam wzorzec co przy `loads` (0001, `set_loads_updated_at`); własna funkcja,
-- żeby nie wiązać dwóch tabel jedną definicją.
create or replace function public.set_plan_vehicles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- `public` MUSI tu być: Postgres nadaje EXECUTE roli PUBLIC z automatu, więc odebranie prawa samym
-- anon/authenticated nic nie zmienia i funkcja dalej stoi w API jako /rest/v1/rpc/. Ta sama pułapka
-- co w 0006 — sprawdzone `has_function_privilege` po zaaplikowaniu, nie po samym "success".
revoke execute on function public.set_plan_vehicles_updated_at() from anon, authenticated, public;

drop trigger if exists plan_vehicles_set_updated_at on public.plan_vehicles;
create trigger plan_vehicles_set_updated_at
  before update on public.plan_vehicles
  for each row execute function public.set_plan_vehicles_updated_at();

-- Realtime: plan układa kilka osób naraz, wiersz ma się przestawiać bez odświeżania strony.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'plan_vehicles'
  ) then
    alter publication supabase_realtime add table public.plan_vehicles;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'plan_absences'
  ) then
    alter publication supabase_realtime add table public.plan_absences;
  end if;
end $$;
