-- Więcej niż jedno miejsce załadunku/rozładunku na zleceniu (właściciel: "zlecenia krajowe, bądź
-- w sumie jakiekolwiek, mogą mieć więcej niż jeden rozładunek/załadunek").
--
-- `stops` trzyma miejsca DRUGIE I DALSZE. Pierwsze zostaje w kolumnach z migracji 0001
-- (company_name / address / city / secondary_date / time_of_day) — czyta je cała reszta appki
-- (Zestawienie, Plan wspaniały, faktura, wyszukiwarka, szablony), a przepisanie go do listy
-- zrobiłoby DWIE KOPIE tej samej prawdy. Kształt elementu listy zna wyłącznie appka
-- (src/types/loadStop.ts), tak jak przy `user_view_settings` — kolejne pole miejsca nie będzie
-- wtedy wymagało migracji.
--
-- Nie ma osobnej tabeli `load_stops`, bo miejsca czyta się i zapisuje ZAWSZE razem ze zleceniem:
-- osobna tabela dokładałaby join do każdego widoku, własne RLS i własny kanał Realtime, nie
-- obsługując żadnego zapytania, którego dziś nie da się zrobić.
--
-- Dziennik zmian (trigger z 0003) obejmuje tę kolumnę bez zmian — porównuje wszystkie kolumny
-- wiersza, więc dopisanie miejsca zostawi ślad "stops: przed → po".

alter table public.loads
  add column if not exists stops jsonb not null default '[]'::jsonb;

comment on column public.loads.stops is
  'Kolejne (2., 3., …) miejsca załadunku/rozładunku: [{kind, company_name, address, city, date, time, notes}]. Pierwsze miejsce siedzi w kolumnach company_name/address/city/secondary_date/time_of_day.';

-- Straż na kształt: lista, nigdy obiekt ani liczba. Zawartości elementów baza NIE waliduje —
-- to świadome (patrz wyżej), ale "to ma być lista" jest tanie i chroni przed zapisem z pomyłki.
alter table public.loads drop constraint if exists loads_stops_is_array;
alter table public.loads
  add constraint loads_stops_is_array check (jsonb_typeof(stops) = 'array');
