-- Ważenie kontenera: CZY jest wymagane i GDZIE (zgłoszenie właściciela: "przy imporcie zleceń
-- brakuje opcji zaciągania / dopisania gdzie i czy wymagane jest ważenie").
--
-- Kolumna na miejsce ważenia już jest — `weighing_export` z arkusza klienta (kolumna R "Ważenie
-- (tylko export)", patrz 0001). Zostaje pod TĄ SAMĄ NAZWĄ, bo nazwa kolumny siedzi w `activity_log`
-- i w zapisanych ustawieniach widoku każdego użytkownika (ta sama zasada, co przy "Złożone kiedy"
-- → "Data złożenia"); zmienia się tylko etykieta w appce na "Ważenie gdzie". Na produkcji kolumna
-- jest pusta we wszystkich wierszach, więc nic nie trzeba przenosić.
--
-- Nowa jest sama odpowiedź "czy": osobna kolumna, a nie słowo doklejone do miejsca, bo po tym
-- dyspozytor filtruje i sortuje dzień ("które zlecenia trzeba zważyć"), a "tak" wpisane w tekst
-- miejsca do niczego takiego się nie nadaje. Typ boolean NULLOWALNY — trzy stany mają różne
-- znaczenia: true = ważenie wymagane, false = wprost niewymagane, NULL = dokument o tym nie mówi.
-- Wymuszenie false na braku informacji kazałoby dyspozytorowi ufać czemuś, czego nikt nie napisał.
alter table public.loads
  add column if not exists weighing_required boolean;

comment on column public.loads.weighing_required is
  'Czy zlecenie wymaga ważenia kontenera. NULL = dokument o tym nie mówi (nie mylić z false = wprost niewymagane).';

comment on column public.loads.weighing_export is
  'Ważenie — GDZIE (np. "w porcie", "waga miejska Gdynia", "SGS"). Kolumna R arkusza klienta ("Ważenie (tylko export)"); nazwa historyczna, dotyczy obu kierunków.';
