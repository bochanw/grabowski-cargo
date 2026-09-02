# grabowski-cargo

Appka dla klienta Grabowski — śledzenie ładunków/kontenerów + fakturowanie. Osobna appka od
Panelu floty (`bochanw/DAB`, appka FleetProfit) — inny stack, inna domena, to repo.
Zob. `bochanw/DAB/CLAUDE.md`, sekcje "Klient Grabowski — Panel floty wdrożony" i "Appka do
kontenerów/ładunków Grabowskiego — ZAŁOŻENIA ARCHITEKTURY ustalone PRZED Excelem" — to źródło
prawdy dla decyzji poniżej, tu tylko streszczenie + stan tego repo.

## Stack (ustalone z właścicielem, nie do renegocjacji bez pytania)

Next.js (App Router, TypeScript) + Tailwind + TanStack Query + Supabase JS SDK (dane, auth,
Realtime, Presence) + Supabase Edge Functions/pg_cron do zadań w tle. `cmdk` do palety poleceń
(Ctrl+K).

## Supabase

Wspólny projekt z Panelem floty Grabowskiego (ten sam login): URL
`https://itlgexjhznjsbonzdxyg.supabase.co`. Klucz publishable w `.env.local.example` (bezpieczny
do użycia w kliencie — nie `service_role`).

**To OSOBNE konto Supabase właściciela, poza zasięgiem Supabase MCP tej i najprawdopodobniej
kolejnych sesji** (potwierdzone: `list_projects` w tej sesji widzi tylko DAB/Demo/ETB, inna
organizacja). Migracje piszemy jako pliki `.sql` w `supabase/migrations/`, aplikowane RĘCZNIE
przez właściciela w SQL Editor — chyba że sprawdzisz `list_projects` i faktycznie masz dostęp.

Panel floty Grabowskiego na tym projekcie ma już: `email_password` auth, `app_roles` +
`is_manager()` (SECURITY DEFINER), RLS wzorem `"wymaga logowania"` (tylko `authenticated`, nigdy
`anon`) — wzorzec w `bochanw/DAB/migrations/001_fleet_store_schema_rls.sql`. Appka ładunków może
korzystać z TEGO SAMEGO auth, ale ma własne, zwykłe tabele — nie miesza się z `fleet_store`
(appka floty jest key-value, appka ładunków NIE jest).

## Wzorzec danych — ŚWIADOMIE inny niż `fleet_store` appki floty

Zwykłe tabele Postgresa, wiersz per rekord, RLS natywne per tabela. `fleet_store` (jeden JSON
blob per klucz) wymagał własnej maszynerii scalania pól + CAS, żeby znieść kilka osób
edytujących naraz — łatka na ograniczenie TEGO wzorca, nie coś do dziedziczenia tutaj. Zwykłe
wiersze dają poprawną współbieżność (`UPDATE ... WHERE id=...`) za darmo.

## Live-update (strona NIE MOŻE się odświeżać)

- Dane: Supabase Realtime `postgres_changes` → TanStack Query (`setQueryData`/`invalidateQueries`).
- Presence: kanał keyowany po `record_id`, `{userId, name}` — "Jan edytuje ten rekord...".
  Świadomie odfiltrować WŁASNE zmiany z toastów (appka floty złapała ten błąd przy
  `isEditingSomething()` nadpisującym wpisywany tekst — nie powtórzyć).
- Reconnect: zwykły `invalidateQueries` po evencie `reconnect` klienta Realtime. NIE próbować
  gapless replay — Realtime Supabase nie gwarantuje dostarczenia zdarzeń z okna rozłączenia.

## Zadania w tle (przyszłe integracje: stan kontenerów, awizacja)

Postgres jako kolejka: tabela `jobs` (status `queued`/`running`/`done`/`error`, `attempt`,
`next_retry_at` na exponential backoff) + Edge Functions + `pg_cron`. UI czyta status przez
Realtime na `jobs` (spinner → ✅/❌, bez pollingu). Błąd zewnętrznego źródła = wiersz `error`,
czytany w osobnym "centrum zadań w tle" — NIGDY nie blokuje głównego widoku. Redis/BullMQ/Celery
dopiero, jeśli scraping urośnie do skali, której Postgres-jako-kolejka nie udźwignie — nie
zakładać od startu.

## Audit trail

`activity_log` (insert-only), realny diff pól (`before`/`after` jako jsonb), aktor = user LUB
`bot:<źródło>`. Świadomie inaczej niż `logChange()` appki floty (tam tylko opis zdarzenia, bez
wartości — po incydencie z utraconymi danymi nie dało się ustalić, co zginęło).

## UX

Layout pod ultrawide (wielokolumnowy, nie wąska lista wycentrowana). Skróty klawiszowe: Ctrl+N
nowe zlecenie, Ctrl+K paleta poleceń/globalne wyszukiwanie (`cmdk`). Globalne wyszukiwanie: filtr
w pamięci (mały zbiór) vs `pg_trgm` server-side (duży) — decyzja PO poznaniu realnej skali danych
klienta.

## Stan repo (2026-09-02)

Next.js + Tailwind + TanStack Query + Supabase JS SDK + `cmdk` zainstalowane. `src/app/providers.tsx`
(QueryClientProvider), `src/lib/supabase/client.ts`.

**Decyzje właściciela (AskUserQuestion, ta sesja) o kształcie danych z arkusza:**
- Duplikaty kolumn (Spedycja F/AT, Numer zlecenia E/BB, Uwagi M/BD) → **redundancja arkusza,
  scalone w jedno pole każda** (`forwarder`, `order_number`, `notes`).
- Pola wyglądające jak zamknięte słowniki (podjęcie, Odprawa, Staus, Wielkość, Dostawa
  bezpośrednia/odprawa) → **zwykły `text` bez CHECK na razie**, dodać CHECK/enum w kolejnej
  migracji, gdy właściciel poda pełne listy wartości.
- "%BAF" (AY) → **wartość procentowa** (mimo że wartości w próbce, 500/300/250, wyglądają
  nietypowo dla %, do zweryfikowania na pełnych danych — patrz komentarz w migracji).

**Napisane w tej sesji:**
- `supabase/migrations/0001_loads_schema_rls.sql` — tabela `loads` (pełny komplet kolumn z
  mapowania arkusza), RLS `"wymaga logowania"` (tylko `authenticated`), trigger `updated_at`,
  indeks pod grupowanie dzień+kierunek i wyszukiwanie po numerze kontenera, Realtime włączony.
  **NIE zaaplikowana na projekcie Supabase** — do ręcznego odpalenia przez właściciela w SQL
  Editor (ta sesja nie miała dostępu MCP do projektu Grabowskiego, potwierdzone przez
  `list_projects`).
- Widok "Zestawienie" (`src/components/zestawienie/`): `ZestawienieTable.tsx` (prezentacyjny,
  grupowanie po dniu, gruba kreska między EKSPORT/IMPORT, przełączniki widoczności bloków
  kolumn Rozliczenie/Fakturowanie/Inne), `ZestawienieView.tsx` (kontener — `useLoads` +
  stany ładowania/błędu), `columns.ts` (definicje 3 bloków kolumn). `src/hooks/useLoads.ts` —
  TanStack Query + Supabase Realtime (`postgres_changes` → `setQueryData`/`invalidateQueries`,
  refetch po reconnect zamiast gapless replay).
- Zweryfikowane lokalnie (mock dane, zrzut ekranu Playwright): grupowanie po dniu, separator
  eksport/import, przełączanie bloków kolumn — działa. **NIE zweryfikowane na żywych danych**
  (tabela jeszcze nie istnieje na projekcie Grabowskiego).

**Do zrobienia w kolejnej sesji:**
1. Właściciel aplikuje `0001_loads_schema_rls.sql` ręcznie w SQL Editor.
2. Zweryfikować end-to-end na żywym projekcie (live insert → Realtime → UI bez odświeżania).
3. Presence ("Jan edytuje..."), Ctrl+N/Ctrl+K (`cmdk`), globalne wyszukiwanie (czeka na
   realną skalę danych klienta), import z Excela (odporny na `#VALUE!` i inne błędy formuł),
   formularz edycji rekordu + `activity_log` (diff before/after), tabela `jobs` do zadań w tle.
4. Wciąż do ustalenia z właścicielem: pełne słowniki wartości (pkt wyżej), skala danych,
   format faktury (Fakturownia vs appka generuje PDF — wzorzec `fakturownia-create-invoice`
   z `bochanw/DAB` prawdopodobnie da się powielić).
