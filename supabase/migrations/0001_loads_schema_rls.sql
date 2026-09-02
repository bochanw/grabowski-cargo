-- ============================================================
-- Migracja startowa dla appki ładunków/kontenerów Grabowskiego.
-- Odpalić RĘCZNIE (SQL Editor w dashboardzie Supabase) na projekcie
-- https://itlgexjhznjsbonzdxyg.supabase.co — TEN SAM projekt co Panel floty
-- Grabowskiego (osobne konto Supabase właściciela, poza zasięgiem MCP tej
-- sesji). Auth/RLS wzorem `wymaga logowania` z
-- bochanw/DAB/migrations/001_fleet_store_schema_rls.sql: tylko
-- "authenticated", nigdy "anon".
--
-- Wzorzec danych ŚWIADOMIE inny niż fleet_store appki floty: zwykła tabela
-- Postgresa, wiersz per ładunek, RLS natywne — nie jeden JSON blob per klucz.
-- Patrz CLAUDE.md w tym repo, sekcja "Wzorzec danych".
--
-- Kolumny odwzorowują arkusz klienta (~60 kolumn, litery Excela w
-- komentarzach dla przyszłego importu). Trzy pary zduplikowanych kolumn w
-- arkuszu (Spedycja F/AT, Numer zlecenia E/BB, Uwagi M/BD) POTWIERDZONE
-- z właścicielem jako redundancja — scalone tu w jedno pole każda.
-- Kolumny, które w próbce wyglądają jak zamknięte słowniki (podjęcie,
-- Odprawa, Staus, Wielkość, Dostawa bezpośrednia/odprawa) są na razie
-- zwykłym textem bez CHECK — właściciel jeszcze nie podał pełnych list
-- wartości; dodać CHECK/enum w kolejnej migracji, gdy je poda.
-- ============================================================

create table if not exists public.loads (
  id                        uuid primary key default gen_random_uuid(),

  -- Blok 1 — dane ładunku/odprawy/kierowcy (kolumny A-AG Excela)
  -- Kolumna A (dzień tygodnia) celowo pominięta — wyliczana z load_date w UI.
  load_date                 date,          -- B "Data"
  pickup_type               text,          -- C "podjęcie" (słownik? patrz nagłówek pliku)
  city                      text,          -- D "Miejscowość"
  order_number              text,          -- E "Numer zlecenia" (scalone z BB, duplikat potwierdzony)
  forwarder                 text,          -- F "Spedycja" (scalone z AT, duplikat potwierdzony)
  container_number          text,          -- G "Nr kontenera"
  shipping_line             text,          -- H "Gestia"
  company_name              text,          -- I "Dane firmy"
  address                   text,          -- J "Adres"
  contact_phone             text,          -- K (bez nagłówka) telefon wolny tekst
  customs_status             text,          -- L "Odprawa" (słownik?)
  notes                     text,          -- M "Uwagi" (scalone z BD, duplikat potwierdzony)
  container_size            text,          -- N "Wielkość" (słownik? np. 20DV/40HC)
  direction                 text not null check (direction in ('I', 'E')), -- O (bez nagłówka) I=import / E=eksport
  secondary_date             date,          -- P "Data" (druga data, podjęcie/dostawa — inna niż load_date)
  time_of_day               text,          -- Q "Godz." (bywa "24h" — text, nie time)
  weighing_export           text,          -- R "Ważenie (tylko export)"
  goods_name                text,          -- S "Nazwa towaru"
  status                    text,          -- T "Staus" [pisownia z arkusza] (słownik?)
  pin_booking               text,          -- U "pin / booking"
  reference_number          text,          -- V "Nr ref."
  net_weight_kg             numeric,       -- W "Waga netto"
  gross_weight               text,          -- X "Waga brutto" (bywa "według armatora" — text)
  driver_rate                text,          -- Y "Stawka dla kierowcy" (format "[500 zł]" — text)
  submitted_when            text,          -- Z "Złozene kiedy" [pisownia z arkusza] (bywa "cut off ..." — text)
  submitted_where           text,          -- AA "Żłożenie gdzie" [pisownia z arkusza]
  driver_initials           text,          -- AB "inicjały kierowców"
  driver_name                text,          -- AC "Kierowca"
  driver_id_number          text,          -- AD "nr dowodu"
  vehicle_plate              text,          -- AE "Pojazd"
  trailer_plate              text,          -- AF "Naczepa"
  driver_phone               text,          -- AG "Telefon" (kierowcy — inne pole niż K)

  -- Blok 2 — rozliczenie z podwykonawcą/przewoźnikiem (kolumny AJ-BA;
  -- AH/AI puste/pominięte w arkuszu)
  carrier_name                text,          -- AJ "Przewoznik"
  documents_received_date    date,          -- AK "Kiedy otrzymano dokumenty"
  subcontractor_rate         numeric,       -- AL "Stawka dla podwykonawcy"
  subcontractor_invoice_number text,        -- AM "Numer faktury podwykoanwcy" [pisownia z arkusza]
  subcontractor_net_amount   numeric,       -- AN "Kwota netto"
  subcontractor_payment_due_date date,      -- AO "Termin płatności"
  subcontractor_paid         text,          -- AP "Zapłacono" (kształt niepotwierdzony — text)
  gct_invoice_number         text,          -- AQ "Numer faktury z GCT+ refaktura"
  rebilling_comment          text,          -- AR "Nasza refaktura/ komentarz"
  settled_weight_kg          numeric,       -- AS "Waga" (inne pole niż W/X — rozliczeniowe)
  -- AT "Spedycja" pominięta — duplikat F, scalone w `forwarder` (potwierdzone z właścicielem)
  delivery_or_customs        text,          -- AU "Dostawa bezposrednia czy odprawa" (enum D/O w przyszłości)
  rate_misc                  text,          -- AV "Stakwa" [pisownia z arkusza, sens niepotwierdzony]
  adr_flag                    text,          -- AW "Sent/ADR" (towary niebezpieczne? kształt niepotwierdzony)
  gct_leasing_addons          numeric,       -- AX "GCT leasing dodatki"
  baf_percentage              numeric,       -- AY "%BAF" — potwierdzone z właścicielem jako wartość procentowa
                                             -- (wartości w próbce 500/300/250 wyglądają nietypowo dla %, do zweryfikowania na pełnych danych)
  baf_amount                  numeric,       -- AZ "Kwota BAF dodana do stawki"
  total_amount                numeric,       -- BA "SUMA"

  -- Blok 3 — fakturowanie (kolumny BB-BG)
  -- BB "Numer zlecenia" pominięta — duplikat E, scalone w `order_number`
  invoice_number              text,          -- BC "Nr faktury"
  -- BD "Uwagi" pominięta — duplikat M, scalone w `notes`
  invoice_amount               numeric,       -- BE "Kwota"
  invoice_payment_date         date,          -- BF "Data platnosci" [pisownia z arkusza]
  invoice_code                 text,          -- BG "KOD"

  -- Dalekie, rzadkie kolumny (CH-CJ, praktycznie puste w próbce)
  correct_data_flag           text,          -- CH "poprawne dane"
  loading_number               text,          -- CI "nr załad."
  wants_own_cmr                text,          -- CJ "Kto chce swój list"

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

alter table public.loads enable row level security;

drop policy if exists "wymaga logowania" on public.loads;

create policy "wymaga logowania"
on public.loads
as permissive
for all
to authenticated
using (true)
with check (true);

-- Grupowanie widoku "Zestawienie" jest po dniu + kierunku (I/E) — indeks
-- wspiera oba naraz. Wyszukiwanie po numerze kontenera jest jednym z
-- pierwszych filtrów, jakich dyspozytor użyje.
create index if not exists loads_load_date_direction_idx
  on public.loads (load_date, direction);

create index if not exists loads_container_number_idx
  on public.loads (container_number);

-- updated_at aktualizowany automatycznie przy każdym UPDATE — appka nie musi
-- o tym pamiętać przy każdym zapisie z formularza.
create or replace function public.set_loads_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists loads_set_updated_at on public.loads;
create trigger loads_set_updated_at
before update on public.loads
for each row execute function public.set_loads_updated_at();

-- Live-update widoku Zestawienie przez Realtime (postgres_changes), bez
-- odświeżania strony — patrz CLAUDE.md, sekcja "Live-update".
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'loads'
  ) then
    alter publication supabase_realtime add table public.loads;
  end if;
end $$;
