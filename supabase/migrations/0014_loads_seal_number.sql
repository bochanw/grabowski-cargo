-- ============================================================
-- Numer plomby + doprecyzowanie "Złożone kiedy" (zgłoszenia właściciela: "pobierz numer plomby",
-- "zmieńmy kolumnę złożone kiedy na data złożenia — i to odczytamy ze zlecenia, często opisane
-- jako cutoff").
--
-- Plomba nie miała odpowiednika w arkuszu klienta (najbliższe kolumny — "Nr ref." i "pin/booking" —
-- znaczą co innego), więc nowa kolumna zamiast doklejania do istniejącej.
--
-- `submitted_when` (arkuszowe "Złozene kiedy") NIE zmienia nazwy w bazie — zmienia się tylko
-- etykieta w appce ("Data złożenia"). Nazwa kolumny siedzi w historii zmian (activity_log) i w
-- ustawieniach widoku każdego użytkownika (user_view_settings.settings), więc przemianowanie
-- kosztowałoby migrację tych danych bez żadnego zysku. ZOSTAJE TEXT-em, nie datą: cut off bywa
-- podany z godziną albo jako warunek ("cut off wg armatora"), a to jest informacja, po której
-- dyspozytor planuje dzień.
-- ============================================================

alter table public.loads
  add column if not exists seal_number text;

comment on column public.loads.seal_number is
  'Numer plomby założonej na kontener — odczytywany ze zlecenia/listu przewozowego.';

comment on column public.loads.submitted_when is
  'Data złożenia kontenera (w dokumentach zwykle "cut off"); text, bo bywa z godziną albo warunkiem.';
