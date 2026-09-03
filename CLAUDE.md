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

**Supabase MCP MA DOSTĘP do tego projektu od 2026-09-02** (właściciel zaprosił konto spod konektora
do organizacji Grabowskiego, org `vhiughdbmhsrsmzayjeh`, projekt `itlgexjhznjsbonzdxyg`). Wcześniej
projekt był poza zasięgiem MCP i migracje aplikował właściciel ręcznie w SQL Editor.
**PUŁAPKA: `list_projects`/`list_organizations` DALEJ pokazują tylko starą organizację
(DAB/Demo/ETB) — nie wnioskuj z tego, że dostępu nie ma.** Sprawdzaj `get_project` z wprost podanym
`itlgexjhznjsbonzdxyg`: jeśli zwróci projekt "Grabowski", masz dostęp i możesz aplikować migracje
(`apply_migration`), wdrażać Edge Functions (`deploy_edge_function`) i czytać żywe dane.
Migracje NADAL piszemy jako pliki `.sql` w `supabase/migrations/` (ślad w repo + możliwość cofnięcia)
— MCP tylko je aplikuje. Czego MCP NIE potrafi: ustawiania sekretów Edge Functions (klucze API
wpisuje właściciel w Dashboard → Project Settings → Edge Functions → Secrets).

**Stan produkcji sprawdzony 2026-09-02 przez MCP:** migracje `0001`–`0005` WSZYSTKIE zaaplikowane
(tabele `loads`, `activity_log`, `contractors`; kolumny terminów płatności, `contractor_id`, pola
faktury), Realtime włączony na `loads`/`activity_log`/`contractors`/`fleet_store`. Edge Functions:
`fakturownia-create-invoice` (v2) i `parse-order-pdf` (v1, wdrożona w tej sesji) — tej drugiej
brakuje jeszcze sekretu `ANTHROPIC_API_KEY` (zwraca wtedy `not_configured`).
`get_advisors` (security): nic pilnego; jedyna uwaga do NASZEGO kodu to `log_loads_activity()`
wystawiona jako RPC dla `anon`/`authenticated` — wywołana wprost i tak rzuci błąd (funkcja
triggerowa), ale przy okazji kolejnej migracji warto zrobić `revoke execute`.

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
1. Właściciel aplikuje `0001_loads_schema_rls.sql` (i `0002_loads_payment_terms.sql`, patrz niżej)
   ręcznie w SQL Editor.
2. Zweryfikować end-to-end na żywym projekcie (live insert → Realtime → UI bez odświeżania).
3. Presence ("Jan edytuje..."), Ctrl+N/Ctrl+K (`cmdk`), globalne wyszukiwanie (czeka na
   realną skalę danych klienta), import z Excela (odporny na `#VALUE!` i inne błędy formuł),
   formularz edycji rekordu + `activity_log` (diff before/after), tabela `jobs` do zadań w tle.
4. Wciąż do ustalenia z właścicielem: pełne słowniki wartości (pkt wyżej), skala danych,
   format faktury (Fakturownia vs appka generuje PDF — wzorzec `fakturownia-create-invoice`
   z `bochanw/DAB` prawdopodobnie da się powielić).

## Import zleceń z PDF (docelowo: mail + szablony znanych klientów + Claude Console; na razie: ręczne)

Właściciel chce w appce guzik do RĘCZNEGO importu zlecenia spedycyjnego (PDF) — zanim powstanie
automatyczne czytanie z maila, per-klient szablony parserów i/lub odczyt przez Claude API/Console.
Ta sesja zrobiła pierwszy krok: ręcznie odczytała przykładowe zlecenie (`Zlecenie_spedycyjne_
ZD_1797_6_2026.pdf`, spedytor Q4Road, import, kontener NYKU9911861) i zmapowała pola na `loads`.

**Trzy pola ze zlecenia PDF nie miały odpowiednika w schemacie z arkusza — potwierdzone z
właścicielem (AskUserQuestion), jak je potraktować:**
- **Miejsce odprawy celnej** (adres agencji celnej) → NIE nowe pole. Właściciel: pole `customs_status`
  ("Odprawa") ma pomieścić zarówno status, jak i miejsce — jedno pole na oba znaczenia.
- **Stawka uzgodniona ze spedytorem** (kwota z samego zlecenia, przed wystawieniem faktury) → NIE
  nowe pole. Właściciel: użyć wprost istniejącego `invoice_amount` (blok Fakturowanie) — appka nie
  rozróżnia "stawka uzgodniona" od "kwota na wystawionej fakturze".
- **Warunek płatności** (np. "60 dni od daty wpływu faktury i listu przewozowego" — termin liczony
  od zdarzenia, nie konkretna data) → NOWE pola, `supabase/migrations/0002_loads_payment_terms.sql`
  (**NIE zaaplikowana**, jak 0001): `payment_terms_days numeric` (liczba dni) + `payment_terms_note
  text` (od czego liczony, wolny tekst) — ustrukturyzowane bardziej niż jedno pole tekstowe,
  właściciel świadomie wybrał to zamiast prostszego pojedynczego text.

`src/types/load.ts` i `src/components/zestawienie/columns.ts` (blok "fakturowanie") już
zaktualizowane o `payment_terms_days`/`payment_terms_note`.

**Guzik "Importuj zlecenie (PDF)" ZBUDOWANY** (właściciel: "zbuduj taki guzik, z czasem będziemy
rozbudowywać go o kolejnych klientów, żebym ręcznie nie dodawał"). **WAŻNA KOREKTA w trakcie tej
samej sesji**: pierwsza wersja od razu wołała Edge Function przez Claude API (patrz niżej) — właściciel
zatrzymał to: *"przeciez my chcemy na ten moment zrobic odczyt ze zlecenia znanego - z czasem dopiero
claude console"*. Poprawiony, docelowy kształt (i to jest to, co appka dziś robi):

1. **Deterministyczny parser znanego szablonu — GŁÓWNA i na razie JEDYNA metoda, działa od ręki, bez
   żadnego wdrożenia ani klucza API:**
   - `src/lib/pdf/extractPdfText.ts` — wyciąga cały tekst PDF-a w przeglądarce przez `pdfjs-dist`
     (worker ładowany przez `new URL(..., import.meta.url)`, potwierdzone że Turbopack poprawnie
     bundluje plik workera do statycznego eksportu).
   - `src/lib/orderTemplates/` — rejestr szablonów per spedytor (`index.ts` → `matchKnownTemplate`),
     pierwszy wpis `q4road.ts` (regexy dopasowane do RZECZYWISTEGO tekstu z pdf.js dla
     `Zlecenie_spedycyjne_ZD_1797_6_2026.pdf`, nie do tekstu odczytanego ręcznie — to miało
     znaczenie, patrz pułapka niżej). Nierozpoznany PDF nie jest błędem — appka po prostu otwiera
     pusty formularz do ręcznego wypełnienia.
   - Kolejni klienci: dopisać kolejny plik w `src/lib/orderTemplates/` (funkcja `detect`+`parse`) i
     dodać do rejestru w `index.ts` — dokładnie to, o co poprosił właściciel.
2. **Edge Function przez Claude API (`supabase/functions/parse-order-pdf/index.ts`) — PODŁĄCZONA jako
   fallback** (od sesji 2026-09-02, patrz sekcja "Odczyt przez Claude podłączony" niżej; wcześniej
   była świadomie odłączona). Funkcja wzorowana WPROST na `bochanw/DAB/supabase/functions/parse-order-pdf` (ten sam kontrakt:
   nic nie zapisuje się samo). Różnica od DAB: appka DAB wycina tekst z PDF-a po stronie klienta
   (pdf.js) + fallback JPEG dla skanów; ta funkcja wysyła PDF WPROST jako `document` (base64) do
   Anthropic Messages API — natywne wsparcie PDF ogarnia też skany. Model: Haiku 4.5. **Świadomie BEZ
   ograniczenia do managera** (DAB gate'uje tę samą funkcję przez `is_manager()` z powodu kosztu API)
   — ta appka ma z założenia służyć WSZYSTKIM dyspozytorom naraz, i na razie w ogóle nie ma podziału
   ról. Do wdrożenia dopiero, gdy właściciel faktycznie zechce podłączyć ten fallback: `supabase
   functions deploy parse-order-pdf --project-ref itlgexjhznjsbonzdxyg` + `supabase secrets set
   ANTHROPIC_API_KEY=sk-ant-... --project-ref itlgexjhznjsbonzdxyg`.
3. `src/types/parsedOrder.ts` — wspólny kształt `ParsedOrder` (i `EMPTY_PARSED_ORDER`), używany przez
   OBIE metody (parser szablonu i, docelowo, Edge Function) — `ImportOrderDialog.tsx` nie wie/nie dba,
   które źródło dostarczyło dane.
4. `src/components/zestawienie/ImportOrderDialog.tsx` — modal: wybór pliku → wyciągnięcie tekstu →
   próba znanego szablonu → podgląd/edycja WSZYSTKICH pól (kierunek I/E jest WYMAGANY przed zapisem —
   kolumna `direction` w bazie ma `not null check (direction in ('I','E'))`) → zapis przez
   `supabase.from('loads').insert(...)`. Ostrzeżenie w UI, gdy stawka jest w innej walucie niż PLN.
   Guzik w pasku Zestawienia (`ZestawienieTable.tsx`).
5. **Zablokowany pre-istniejący brak**: appka NIE MIAŁA żadnego logowania — RLS `"wymaga logowania"`
   na `loads` blokowało kompletnie WSZYSTKO (i odczyt, i zapis) bez sesji. Dopisane jako fundament:
   `src/hooks/useSession.ts`, `src/components/auth/LoginForm.tsx` (e-mail+hasło, `signInWithPassword`
   — pasuje do `login_mode: "email_password"` już ustawionego dla Grabowskiego), `src/components/
   auth/AuthGate.tsx` (owija `<Home>`). Istniejące konto `wiktor@fleetprofit.eu` (Panel floty)
   powinno działać też tutaj — TEN SAM projekt Supabase, wspólny `auth.users`.

**Pułapka złapana i naprawiona w tej sesji — regex parsera testowany na TEKŚCIE Z JEDNEJ STRONY
zamiast na tym, co appka faktycznie produkuje.** Pierwsza wersja `q4road.ts` kończyła dopasowanie
stawki kotwicą `$` (koniec tekstu) po słowie "Stawka" — działało w izolowanym teście Node na samej
stronie 1 PDF-a, ale appka skleja WSZYSTKIE strony w jeden ciąg (`extractPdfText`), więc w
rzeczywistości po "Stawka" szedł dalej tekst strony 2 (Ogólne warunki zlecenia) i `$` nigdy nie
pasował — pola Stawka/Termin płatności/Warunek płatności wychodziły puste, reszta pól OK. Znalezione
dopiero przez faktyczny test w przeglądarce (Playwright + prawdziwy plik) z realną appką, nie przez
ponowne odpalenie tego samego izolowanego skryptu Node — **wniosek: testować regex/parser na
DOKŁADNIE tej samej ścieżce kodu i tych samych danych wejściowych, które produkuje appka, nie na
uproszczonej reprodukcji.** Naprawione: `\s+Stawka\b` (granica słowa) zamiast `\s+Stawka\s*$`.

Zweryfikowane w przeglądarce (Playwright, prawdziwy plik `Zlecenie_spedycyjne_ZD_1797_6_2026.pdf`,
nie mock): rozpoznanie szablonu Q4Road, WSZYSTKIE pola poprawnie wypełnione (numer zlecenia,
spedycja, kierunek, kontener, wielkość, gestia, firma/adres/miejscowość rozładunku, data i godzina
rozładunku, miejsce odprawy celnej, stawka, termin i warunek płatności). **NIE zweryfikowane
end-to-end zapisu do żywej bazy** (środowisko sesji nie ma prawdziwego konta do zalogowania) —
właściciel już to testuje na produkcji, patrz zgłoszony błąd cache schematu PostgREST niżej.

**Potwierdzone NA PRODUKCJI przez właściciela (Netlify + żywy projekt Supabase, konto
`wiktor@fleetprofit.eu`)**: logowanie działa, import Q4Road odczytuje pola poprawnie, zapis do `loads`
działa (pierwszy rekord ZD/1797/6/2026 widoczny w Zestawieniu). Błąd `Could not find the
'payment_terms_days' column ... in the schema cache` po drodze był stałym cache'em PostgREST po
ręcznej migracji — ustąpił po stronie właściciela (dokładna metoda nieustalona: `NOTIFY pgrst,
'reload schema'` / przycisk "Reload schema cache" / restart projektu). Na przyszłość: po KAŻDEJ
ręcznej migracji w SQL Editor spodziewać się tego błędu i od razu odświeżać cache.

**Poprawki po pierwszym teście produkcyjnym (zgłoszenia właściciela, ta sama sesja):**
- **Poziomy pasek przewijania zasłaniał ostatni wiersz** — klasyczny błąd flexboxa: element
  `flex-1 overflow-auto` bez `min-h-0` nie może być niższy niż zawartość, więc kontener rósł do
  wysokości danych i scrollbar lądował tuż pod nimi. Naprawione: `h-dvh overflow-hidden` na
  korzeniu strony (`page.tsx`) + `min-h-0` w całym łańcuchu (`AuthGate`, `ZestawienieTable`).
  Zweryfikowane Playwrightem: kontener przewijania = pełna wysokość okna.
- **Domyślna "Data" = poprzedni dzień roboczy przed rozładunkiem/załadunkiem** (właściciel:
  "docelowo będzie to poprzedni dzień roboczy poprzedzający rozładunek/załadunek").
  `src/lib/dates/workingDays.ts` — pon-pt z pominięciem polskich dni ustawowo wolnych (stałe +
  Poniedziałek Wielkanocny + Boże Ciało liczone z Wielkanocy; Wigilia wolna od 2025). Stosowane w
  `ImportOrderDialog` po rozpoznaniu szablonu, gdy `load_date` puste a `delivery_date` znane —
  TYLKO jako propozycja do formularza, dyspozytor może zmienić. Testy (Node `--experimental-
  strip-types`, 8 przypadków: weekend, majówka, Wielkanoc, Boże Ciało, Boże Narodzenie, Nowy Rok)
  przechodzą. Rekord zaimportowany PRZED tą zmianą ma pustą datę ("Bez daty") — do ręcznego
  ustawienia przez "Edytuj".
- **Edycja istniejącego rekordu — ZBUDOWANA** (właściciel: "dodaj możliwość edytowania zlecenia
  (na samym końcu) i ręcznego przestawienia tego"). Przycisk "Edytuj" w OSTATNIEJ kolumnie każdego
  wiersza Zestawienia → ten sam `ImportOrderDialog` z propem `existingLoad` (stage od razu
  "review", pola z rekordu przez `loadToForm`, zapis `update ... eq('id')` zamiast `insert`).
  **Ograniczenie**: edycja obejmuje TE SAME pola co import (ok. 18), nie wszystkie ~60 kolumn —
  pełny formularz edycji to osobne zadanie. Zmiana wraca do tabeli przez Realtime (UPDATE →
  `setQueryData`). **BEZ `activity_log`** — wg architektury każda edycja ma zostawiać diff
  before/after; to następny krok (nowa migracja do ręcznego zaaplikowania), świadomie nie
  doklejony teraz, żeby nie mnożyć ręcznych migracji w trakcie testów właściciela.

**Import z DWÓCH dokumentów + edycja inline (ta sama sesja, kolejne zgłoszenia właściciela):**
- U Q4Road (i "pewnie innych w przyszłości") jedno zlecenie = DWA PDF-y: zlecenie spedycyjne +
  **"Kontenerowy list przewozowy"** (dokument dla kierowcy: kierowca, dowód, ciągnik/naczepa,
  telefon, miejsce podjęcia, PIN/booking, nazwa towaru, waga brutto, miejsce złożenia pustego).
  Przykład: `36729_Import_NYKU9911861_Oleksandr_Boichenko.pdf` do tego samego ZD/1797/6/2026.
- `src/lib/orderTemplates/q4road.ts` ma teraz DWA parsery (`parseQ4RoadOrder`, `parseQ4RoadWaybill`)
  ze wspólnymi kawałkami (nagłówek "Import | nr", tabela rozładunku). Wykrywanie po nagłówku
  dokumentu ("ZLECENIE SPEDYCYJNE" vs "KONTENEROWY LIST PRZEWOZOWY") + "q4road" — samo "q4road"
  już nie wystarcza, bo oba dokumenty je mają. Rejestr w `index.ts`: bardziej specyficzny przed
  ogólnym.
- `ParsedOrder` rozszerzony o 10 pól z listu; `mergeParsedOrders(base, incoming)` wypełnia TYLKO
  puste pola — kolejność wgrywania nie ma znaczenia, ręczne poprawki dyspozytora nie są nadpisywane.
  `ImportOrderDialog`: wybór wielu plików naraz + "Dopnij kolejny dokument" w trakcie przeglądu;
  ostrzeżenie, gdy numery zleceń z dwóch dokumentów się różnią.
- **"Podjęcie" = lista rozwijana GCT / BCT / BHub** (właściciel: "możliwe tylko jedno z 3 — dopasuj
  ze zlecenia, zostaw możliwość przestawienia"). `pickupLocations.ts`: `matchPickupLocation("GCT
  Gdynia") → "GCT"`. Kolumna w bazie to nadal zwykły text bez CHECK — wartość spoza listy (np.
  "poimport" z arkusza) formularz/edytor pokazują jako dodatkową opcję zamiast gubić.
- Test `npx tsx scratch-templates.test.mts` (plik tymczasowy, nie w repo — wzorzec do odtworzenia):
  oba PDF-y przez DOKŁADNIE tę samą ścieżkę co appka (wszystkie strony sklejone), 38 sprawdzeń pól +
  symetria scalania. Zweryfikowane też w przeglądarce (Playwright, oba pliki jednym wgraniem).
- **Edycja inline ZAMIAST okna "Edytuj"** (właściciel: "bezpośrednio na tabeli wykonamy operację i
  zatwierdzimy enterem"). `ZestawienieTable`: klik w komórkę → `CellEditor` (input wg `kind`:
  date/number/text; `<select>` dla `direction` i `pickup_type`) → **Enter zapisuje, Esc anuluje,
  klik poza komórką ANULUJE** (zapis tylko świadomym Enterem; listy zapisują od razu po wyborze).
  `useUpdateLoadField` (`useLoads.ts`): optymistyczny `setQueryData` + `update ... eq('id')`,
  cofnięcie i komunikat w pasku przy błędzie. Kolumna/przycisk "Edytuj" USUNIĘTE; `ImportOrderDialog`
  zachował prop `existingLoad` (nieużywany — może się przydać do edycji "wszystkiego naraz").
  Edycja inline obejmuje KAŻDĄ widoczną kolumnę (także bloki rozliczenie/fakturowanie/inne po
  włączeniu) — więcej niż dawne okno.
- Nadal BEZ `activity_log` — teraz jeszcze ważniejsze, bo każda komórka jest edytowalna.

**Dopinanie dokumentu / usuwanie / pola z Panelu floty (ta sama sesja, zgłoszenie właściciela:
"zlecenie wgrane tylko częściowo nie jest możliwe do usunięcia ewentualnie dodania dokumentu" +
"pojazd, naczepa, kierowca, nr dowodu, telefon — będziemy zaciągać z panelu floty, to nie są pola
z dowolnymi wartościami; jeżeli nie uda się dopasować — zassij z poprzedniego zlecenia"):**
- Ostatnia kolumna każdego wiersza: **"Dopnij PDF"** (ten sam `ImportOrderDialog` w trybie
  `mode="attach"`: stage "pick", formularz z rekordu, dokument wypełnia TYLKO puste pola, zapis
  `update`) i **"Usuń"** (`window.confirm` z numerem zlecenia → `useDeleteLoad`, optymistycznie,
  Realtime DELETE po `old.id`). `useUpdateLoadField` → `useUpdateLoad(id, patch)` (wybór kierowcy
  ustawia naraz imię + nr dowodu).
- `src/lib/fleet/fleetStore.ts` — odczyt Panelu floty z TEGO SAMEGO projektu Supabase: tabela
  `fleet_store`, klucze `vehicles`/`drivers`/`driver_documents` (polityka "flota - manager i
  pracownik" = każdy zalogowany; NIGDY nie zapisujemy, źródłem prawdy zostaje Panel floty).
  Kształty rekordów skopiowane z `bochanw/DAB/templates/src` (pojazd: `plate`, `plateB`, `type`
  ciagnik/naczepa/solowka, `assignedTrailerPlate`; kierowca: `name`; dokument: `{driverId,
  docNumber}`). **Panel floty NIE MA telefonu kierowcy** — telefon zostaje z dokumentu zlecenia albo
  z poprzedniego zlecenia; jeśli właściciel chce go trzymać we flocie, to zmiana po stronie DAB.
  Normalizacja tablic/nazwisk skopiowana z `21-rent-narzedzia-parsery.js` (bez aliasów literówek —
  `plate_aliases` tej appki nie dotyczy).
- `reconcileWithFleet(parsed, fleet, recentLoads)` — reguła właściciela wprost: (1) dopasuj do
  floty (tablica/nazwisko z floty jest kanoniczne, nr dowodu z `driver_documents`), (2) brak
  dopasowania → wartość z NAJNOWSZEGO zlecenia z wypełnionym polem, (3) brak i tego → wartość z
  dokumentu zostaje. Każde odstępstwo = ostrzeżenie w formularzu, a wartość z dokumentu jest zawsze
  na liście jako "(spoza Panelu floty)" — jednym kliknięciem da się ją przywrócić (świadomie: reguła
  "z poprzedniego zlecenia" może podstawić innego kierowcę niż w dokumencie, więc nic nie ginie po
  cichu). Ciągnik z floty bez naczepy → stała naczepa z `assignedTrailerPlate`. Test logiki:
  `npx tsx scratch-reconcile.test.mts` z dummy env (`NEXT_PUBLIC_SUPABASE_URL=... ANON_KEY=...`,
  bo moduł importuje klienta Supabase), 20 przypadków — plik tymczasowy, nie w repo.
- Formularz i edycja inline: Kierowca / Pojazd / Naczepa to `<select>` z floty (+ bieżąca wartość
  spoza listy); wybór kierowcy dopisuje nr dowodu, wybór ciągnika podpowiada stałą naczepę.
- **NIE zweryfikowane na żywych danych floty Grabowskiego** (środowisko bez konta) — nieznane, czy
  `vehicles`/`drivers` są tam wypełnione; z pustą flotą appka zachowuje się jak przed zmianą
  (wartości z dokumentu + ostrzeżenia). Pierwszy test właściciela pokaże, czy dopasowanie trafia.

**`activity_log` — ZROBIONY (właściciel: "jak to zrobisz, to ogarnij dziennik zmian").**
`supabase/migrations/0003_activity_log.sql` (**NIE zaaplikowana**, jak poprzednie — ręcznie w SQL
Editor + odświeżenie cache PostgREST). Zapis idzie **triggerem AFTER INSERT/UPDATE/DELETE na
`loads`**, nie z kodu appki — od kiedy każda komórka jest edytowalna, a rekordy da się dopinać i
usuwać, tylko trigger gwarantuje, że żadna ścieżka (import, "Dopnij PDF", Enter w komórce, "Usuń",
przyszłe boty przez service_role) nie ominie dziennika. Diff liczony w SQL: update = tylko
faktycznie zmienione pola (`updated_at` pomijany; update bez zmian NIE tworzy wpisu), insert =
cały rekord w `after`, delete = cały rekord w `before`. Bez FK do `loads` (usunięcie zlecenia ma
zostawić historię), `order_number` jako migawka. Aktor: `app.actor` (bot ustawia
`select set_config('app.actor','bot:<źródło>',true)` w tej samej transakcji) → e-mail z JWT →
`bot:<rola>`. RLS: SELECT + INSERT dla `authenticated`, brak update/delete = insert-only z appki.
**Trigger zweryfikowany na żywym Postgresie** — kopia migracji odpalona przez MCP na projekcie
Demo (`bkliskynjbrzqudvjizi`) w jednorazowym schemacie `scratch_cargo` (insert → update dwóch pól →
update bez zmian → delete z `app.actor`), schemat skasowany po teście.
Appka: `src/hooks/useActivityLog.ts` (TanStack + Realtime INSERT, 200 ostatnich),
`src/components/zestawienie/ActivityLogPanel.tsx` (panel boczny "Historia" w pasku Zestawienia:
kto, kiedy, "pole: przed → po" z etykietami kolumn). Realtime na `activity_log` włączony w migracji.

**Kontrahenci — ZROBIONE** (właściciel: "dodamy opcję kontrahenci, skonfigurujemy na sztywno termin
płatności, nr NIP i inne dane potrzebne do wysyłki faktur bezpośrednio do Fakturowni").
`supabase/migrations/0004_contractors.sql` (**NIE zaaplikowana**): tabela `contractors` z polami
dobranymi pod kontrakt `fakturownia-create-invoice` z DAB (`name`→buyer_name, `nip`→buyer_tax_no,
`address`/`postal_code`/`city`→buyer_street, `email`→buyer_email, `vat_eu` → stawka "np",
`payment_terms_days`/`_note` → payment_to) + `aliases text[]` (nazwy z dokumentów) + `loads.
contractor_id` (FK `on delete set null` — usunięcie kontrahenta nie kasuje zleceń). `forwarder`
(tekst z PDF-a) ZOSTAJE obok — to, co spedytor sam o sobie napisał; `contractor_id` to nasze dane.
Appka: `src/types/contractor.ts` (`findContractorByName` — bez wielkości liter, interpunkcji i
formy prawnej: "Q4Road Sp. z o.o" == "q4road"), `src/hooks/useContractors.ts` (Realtime + zapis/
usuwanie), `ContractorsDialog.tsx` (przycisk "Kontrahenci" w pasku: lista + formularz), kolumna
"Kontrahent" w bloku Fakturowanie (wyświetla nazwę, edycja inline listą). Import: spedytor z PDF-a
→ kontrahent po nazwie/aliasie; **domyślny termin płatności kontrahenta wchodzi TYLKO w puste pola**
(dokument wygrywa, rozbieżność = ostrzeżenie); brak dopasowania = ostrzeżenie z podpowiedzią, żeby
dodać alias. Wybór kontrahenta w tabeli też podstawia termin, jeśli zlecenie go nie ma.
**Kontrahent zakłada się SAM przy pierwszym zleceniu od nowego spedytora** (właściciel po
teście: "nawet po usunięciu i dodaniu na nowo zlecenia Q4Road nie wyświetla się w kontrahentach" —
oczekiwanie: import ma tworzyć kontrahenta, nie tylko dopasowywać). `parseQ4RoadOrder` wyciąga z
nagłówka zlecenia `forwarder_nip/_address/_postal_code/_city` (nowe pola `ParsedOrder`);
`ImportOrderDialog.ensureContractor()` przy ZAPISIE (nie przy parsowaniu — anulowany import nie
ma śmiecić) sprawdza raz jeszcze po nazwie i, gdy brak, wstawia kontrahenta (nazwa z dokumentu
jako `name` I alias, NIP, adres, termin płatności z dokumentu) i podpina `contractor_id`. E-mail do
faktur trzeba dopisać ręcznie w "Kontrahenci" — dokument go nie ma.
**Waga brutto = waga towaru + tara kontenera wg typu** (właściciel: "20DV 2200 kg, 40DV 3700 kg,
40HC 3900 kg, 45 4800 kg"). `src/lib/containers/tare.ts`: `containerTareKg` (normalizacja typu do
rodziny 20 / 40 / 40HC-HQ / 45; nieznany = null, nie zgadujemy), `computeGrossWeightKg`,
`canOverwriteGrossWeight` (nadpisujemy tylko puste albo czysto liczbowe brutto — "według armatora"
z arkusza zostaje), `parseWeightKg`. **Zmiana mapowania**: "Waga towaru brutto" z listu
przewozowego = waga TOWARU → `net_weight_kg` (wcześniej szła do `gross_weight`); `gross_weight`
jest teraz WYLICZANE (text, bo kolumna z arkusza bywa tekstem). Liczone: przy imporcie po scaleniu
dokumentów (typ z jednego, waga z drugiego), przy edycji pól wagi netto/typu w formularzu i przy
edycji inline tych kolumn w tabeli (`buildPatch` dokłada `gross_weight` do patcha). Test:
`npx tsx scratch-tare.test.mts` (19 przypadków, plik tymczasowy).
**Wysyłka faktury do Fakturowni — ZBUDOWANA** (właściciel: "podepnijmy testowo moją fakturownię").
- `supabase/functions/fakturownia-create-invoice/index.ts` — kopia wzorca z DAB, bez `is_manager()`
  (jak wszystko w tej appce), `oid` = id zlecenia + `oid_unique` (Fakturownia sama odrzuci dubel).
  Data wystawienia = dziś, sprzedaży = rozładunek, `payment_to` = dziś + dni terminu, VAT 23%/np jak w
  DAB. **NIE wdrożona przez tę sesję** (brak dostępu do projektu Grabowskiego): `supabase secrets
  set FAKTUROWNIA_SUBDOMAIN=... FAKTUROWNIA_API_TOKEN=... --project-ref itlgexjhznjsbonzdxyg` +
  `supabase functions deploy fakturownia-create-invoice --project-ref itlgexjhznjsbonzdxyg`
  (albo Dashboard → Edge Functions → nowa funkcja, wklejony kod; sekrety w Project Settings → Edge
  Functions → Secrets). Bez wdrożenia appka pokazuje czytelnie "funkcja nie wdrożona"/"brak sekretów".
- `src/lib/invoice/invoiceTitle.ts` — tytuł pozycji wg reguły właściciela: "Transport kontenera
  <nr>, na trasie <trasa>, nr zlecenia <nr>"; import "<port> - <miejscowość> - <port>", eksport
  "Poimport|z Depotu - <miejscowość> - <port>" (wybór w oknie faktury, bo appka nie wie, skąd pusty).
  **Założenie do potwierdzenia**: port po terminalu podjęcia — GCT/BCT = Gdynia, BHub/brak = Gdańsk
  (właściciel napisał "Gdańsk", ale GCT/BCT leżą w Gdyni). Tytuł jest edytowalny przed wysłaniem.
- `supabase/migrations/0005_loads_invoice_link.sql` (**NIE zaaplikowana**): `fakturownia_invoice_id`,
  `invoice_url`, `invoice_issued_at`. Numer faktury → istniejące `invoice_number`, termin →
  `invoice_payment_date`. `InvoiceDialog.tsx` (przycisk "Faktura" przy wierszu; "Faktura ✓" gdy
  wystawiona — drugi raz nie wystawi): nabywca z kontrahenta (blokada bez kontrahenta/NIP-u), tytuł,
  kwota, termin — wszystko do edycji przed kliknięciem; po sukcesie zapis numeru/linku przy zleceniu
  (trigger loguje to w `activity_log`). `src/lib/supabase/createInvoice.ts` — helper (404 = "nie
  wdrożona"). Test tytułów: `npx tsx scratch-invoice.test.mts` (9 przypadków, plik tymczasowy).
  Pierwszy test u właściciela na żywej Fakturowni: **działa** (faktura wystawiona), z trzema
  poprawkami zgłoszonymi od razu — patrz niżej.

**Poprawki po pierwszej realnej fakturze + wyszukiwarka (zgłoszenie właściciela: "wysyła kwotę z
frachtu jako brutto a to jest netto", "potrzebuję kilka pozycji na jednej fakturze i wybór daty
sprzedaży", "bezwzględnie potrzebuję wyszukiwarkę"):**
- **Kwoty NETTO**: pozycja idzie jako `price_net` (było `total_price_gross`) — Fakturownia dolicza
  VAT. **Funkcję trzeba wdrożyć PONOWNIE** (Dashboard → Edge Functions → Via Editor, ten sam kod).
- **Faktura zbiorcza**: funkcja przyjmuje `loadIds[]` + `positions[]` (jedna pozycja = jedno
  zlecenie), `oid` = id zleceń złączone `+` (dubel dalej blokowany przez `oid_unique`). W tabeli
  checkbox przy każdym wierszu → w pasku "Wystaw fakturę (N)". Blokady: różni kontrahenci w
  zaznaczeniu, zlecenie już zafakturowane. Po sukcesie faktura podpina się do KAŻDEGO zlecenia
  osobno (`invoice_amount` = kwota jego pozycji).
- **Data sprzedaży wybierana** (ładunki bywają z różnych dni) — domyślnie najpóźniejsza data
  rozładunku z zaznaczonych, do zmiany w oknie. Termin płatności też edytowalny.
- **Wyszukiwarka** (`src/lib/search/loadSearch.ts`): filtr w pamięci po WSZYSTKICH polach rekordu
  + nazwie kontrahenta; zapytanie dzielone na słowa (każde musi wystąpić, kolejność dowolna), bez
  wielkości liter i polskich znaków, tablice dopasowywane też bez spacji/myślników ("gpuly42" ==
  "GPU LY42"). Pole w pasku Zestawienia, **Ctrl+K** ustawia w nim kursor, Esc czyści, obok licznik
  "N z M". Zgodnie z CLAUDE.md to świadomie filtr w pamięci — `pg_trgm` dopiero, gdy zbiór urośnie.
  Test: `npx tsx scratch-search.test.mts` (14 przypadków, plik tymczasowy).
  Zweryfikowane w przeglądarce: Ctrl+K, filtrowanie jedno- i wielosłowowe, zaznaczenie 2 zleceń →
  okno faktury zbiorczej z dwiema pozycjami, poprawnymi tytułami (import/eksport), sumą netto.

**Pułapka Realtime złapana NA PRODUKCJI (właściciel: po kliknięciu "Kontrahenci" ekran "This page
couldn't load"): `supabase.channel(nazwa)` zwraca ISTNIEJĄCĄ instancję dla powtórzonej nazwy, a
drugie `.on(...).subscribe()` na niej rzuca wyjątek** ("cannot add postgres_changes callbacks ...
after subscribe()") — `ZestawienieTable` i `ContractorsDialog` wołały `useContractors()` naraz, oba
pod kanałem `contractors-changes`. Odtworzone w izolowanym Node (realtime-js 2.113). Naprawione:
KAŻDY hook Realtime (`useLoads`, `useContractors`, `useActivityLog`) buduje nazwę kanału z
`useId()` — jeden hook może być użyty w wielu komponentach naraz. Wniosek na przyszłość: nazwa
kanału Realtime = per instancja, nigdy stała. Do tego `src/app/error.tsx` — własny ekran błędu z
TREŚCIĄ wyjątku (domyślny Next.js pokazuje tylko "This page couldn't load", nie dało się zdalnie
ustalić przyczyny bez repro). Testy przeglądarkowe w dev tego NIE złapały (mock bez backendu —
subscribe bez połączenia nie doszedł do drugiego `.on()`), więc weryfikacja z prawdziwym
backendem nadal jest niezastąpiona.

**Odczyt przez Claude podłączony + widoczny wybór plików + tryb ręczny (zgłoszenie właściciela:
"1. Potrzebuje polaczenie z platforma claude do odczytu. 2. Guzik wybierz pliki musi byc bardziej
widoczny. 3. Musi byc manualne przejscie na reczne wpisywanie zlecenia."):**
- **Kolejność odczytu: znany szablon → Claude → ręcznie.** `ImportOrderDialog.handleFiles` woła
  `parseOrderPdf(file)` (Edge Function) dopiero, gdy `matchKnownTemplate` zwróci `null` — szablon
  jest darmowy, natychmiastowy i deterministyczny, więc do modelu idą TYLKO nieznane dokumenty.
  Ekstrakcja tekstu pdf.js, która się wywali (skan bez warstwy tekstowej), NIE kończy odczytu —
  Claude dostaje oryginalny PDF, nie tekst, więc dla skanów to jedyna działająca ścieżka. Nierozpo-
  znany dokument dalej nie jest błędem: zostaje formularz do ręcznego wypełnienia + ostrzeżenie z
  TREŚCIĄ błędu (np. "funkcja nie wdrożona", "brak klucza ANTHROPIC_API_KEY").
- Schemat narzędzia w Edge Function dopisany o brakujące pola (dawny punkt "UWAGA" z listy TODO):
  `forwarder_nip/_address/_postal_code/_city` + 10 pól z listu przewozowego (kierowca, dowód,
  pojazd, naczepa, telefon, podjęcie, PIN/booking, towar, waga, miejsce złożenia pustego). System
  prompt mówi teraz wprost, że dokument bywa listem przewozowym, a nie zleceniem.
- `normalizeParsedOrder(raw)` w `src/types/parsedOrder.ts` — KAŻDA odpowiedź modelu przechodzi przez
  nią przed wejściem do formularza. Powód konkretny, nie kosmetyczny: `mergeParsedOrders` traktuje
  `undefined` jak wartość (`isEmpty(undefined) === false`), więc brakujący klucz z modelu wpisałby
  `undefined` w input i zamienił kontrolowany input Reacta w niekontrolowany. Normalizacja domyka
  komplet kluczy, przycina spacje, wymusza `I`/`E` i parsuje liczby podane jako string ("1 250,50").
  `pickup_type` z modelu przechodzi przez `matchPickupLocation`, żeby trafić w listę GCT/BCT/BHub.
  Test: `npx tsx scratch-norm.test.mts` (14 przypadków, plik tymczasowy).
- **Funkcja WDROŻONA na produkcji** (`parse-order-pdf` v1, przez MCP — patrz sekcja "Supabase" o
  dostępie). Sprawdzona strzałem curl-em z kluczem publishable: odpowiada `{"ok":false,"reason":
  "not_configured"}`, czyli działa i czeka na sekret. **BRAKUJE tylko `ANTHROPIC_API_KEY`** —
  Dashboard → Project Settings → Edge Functions → Secrets (MCP nie ustawia sekretów). Do tego czasu
  appka działa jak dotąd (szablon albo ręcznie) i pokazuje wprost powód: brak klucza.
- **Guzik wyboru plików**: zamiast gołego `<input type="file">` (szara systemowa kontrolka "Wybierz
  pliki / Nie wybrano pliku") jest pole zrzutu z dużym czarnym guzikiem "Wybierz pliki PDF" +
  drag & drop ("albo przeciągnij je tutaj"). Sam input jest `hidden` i klikany przez `ref`.
  W trybie przeglądu "Dopnij kolejny dokument" to też guzik (`<label>` z ukrytym inputem).
- **Tryb ręczny**: guzik "Wpisz zlecenie ręcznie (bez PDF-a)" na pierwszym ekranie przechodzi od
  razu do formularza (`startManual`) — ten sam formularz i ten sam zapis co przy imporcie, dokument
  da się dopiąć później ("Dopnij PDF" przy wierszu). Guzik w pasku Zestawienia i tytuł okna zmienione
  na "Nowe zlecenie (PDF / ręcznie)", żeby ręczna droga była widoczna, zanim ktoś otworzy okno.
- Zweryfikowane w przeglądarce (Playwright, dev): ekran wyboru z widocznym guzikiem, przejście w tryb
  ręczny, oraz ścieżka fallbacku na PDF-ie spoza znanych szablonów — appka faktycznie woła
  `parseOrderPdf` i pokazuje czytelny powód niepowodzenia (w tym środowisku "Brak aktywnej sesji",
  bo nie ma konta do zalogowania). **NIE zweryfikowany realny odczyt przez model** — wymaga wdrożonej
  funkcji i klucza API, czyli pierwszego testu u właściciela.

**Pierwsze zlecenie EKSPORTOWE przez Claude — poprawki po uwagach właściciela (`Zlecenie_
transportowe_spedycja_TIIU218.pdf`, spedytor Euro Logistics, PasCom, załadunek cukru w Kruszwicy):**
- Odczyt przez Claude działa na produkcji (klucz `ANTHROPIC_API_KEY` wpisany przez właściciela).
  Funkcja jest w wersji **v4** — v1 to pierwsze wdrożenie, v3/v4 to te poprawki promptu.
- Uwagi właściciela i co z nimi zrobione:
  1. **"Podjęcia nie ma — stąd POIMPORT (inna sytuacja: z depotu)."** `PICKUP_LOCATIONS` to teraz
     **GCT / BCT / BHub / Poimport / Depot** (`pickupLocations.ts`, dopasowanie po wariantach
     zapisu: "Baltic Hub"→BHub, "po imporcie"→Poimport, "z depotu"→Depot). Test:
     `npx tsx scratch-pickup.test.mts` (14 przypadków, plik tymczasowy).
  2. **"Przy eksporcie rozładunek zmieniamy na załadunek."** Etykiety FORMULARZA zależą od
     kierunku (`isExport`): "Firma (załadunek)", "Data załadunku", "Godzina załadunku", "…dzień
     roboczy przed załadunkiem". Kolumny TABELI zostają neutralne ("Data (2)", "Godz.",
     "Złożenie gdzie") — jedna tabela miesza oba kierunki, więc nagłówek nie może być zależny od
     wiersza.
  3. **"Miejsce/status odprawy celnej powinno być puste."** Model wpisywał tam POIMPORT, bo
     rubryka MIEJSCE ODPRAWY w tym zleceniu jest pusta i wartość z sąsiedniej kolumny "przesuwała
     się" w tekście. Prompt ma teraz regułę wprost o tabelach z pustymi rubrykami + zakaz
     traktowania pochodzenia kontenera jako odprawy.
  4. **"Przy eksporcie nie zdajemy pustego, tylko pełny."** Etykieta zmienia się na **"Miejsce
     zdania kontenera (pełny)"**; opis pola w schemacie funkcji też rozróżnia oba kierunki.
- Przy okazji złapane w tym samym dokumencie (właściciel nie zgłaszał, ale ma znaczenie dla faktur):
  - **`forwarder` szedł jako ZAŁADOWCA (Krajowa Grupa Spożywcza), a nie zleceniodawca.** Fakturę
    wg dokumentu wystawia się na **Euro Logistics Sp. z o.o.** ("FAKTURĘ PROSZĘ WYSTAWIĆ NA…").
    Prompt ma teraz kolejność rozstrzygania: firma wskazana do fakturowania → firma wystawiająca
    dokument; nigdy Grabowski i nigdy załadowca/nadawca/odbiorca. To samo pole zakłada kontrahenta,
    więc błąd szedłby wprost na fakturę.
  - **Adres/miejscowość** brały siedzibę firmy z nagłówka (Toruń) zamiast miejsca załadunku
    (Kruszwica); **PIN/booking** dostawał numer rejestracyjny ciągnika zamiast numeru BKG.
- Zweryfikowane strzałem w produkcyjną funkcję TYM PDF-em (nie na uproszczonej reprodukcji):
  wszystkie 22 sprawdzone pola poprawne — kierunek E, Euro Logistics + NIP, Kruszwica/Niepodległości
  38/40, odprawa pusta, podjęcie POIMPORT, zdanie BCT, booking 9020956380, cukier 22288 kg, 1450 PLN,
  30 dni, kierowca/dowód/ciągnik/naczepa z dokumentu.

**Widok per użytkownik — ZROBIONE** (właściciel: "konfiguracja w supabase — dałbym użytkownikom
możliwość ręcznego ustalania co chcą widzieć bez narzucania. Wybór pól i kolejność daj. Wystarczy
zamrozić pierwsze N kolumn — one zawsze będą na maksa z lewej"):
- `supabase/migrations/0007_user_view_settings.sql` — **ZAAPLIKOWANA przez MCP** (pierwsza migracja
  tej appki, której właściciel nie musiał wklejać ręcznie; cache PostgREST odświeżony przez
  `notify pgrst, 'reload schema'` od razu po migracji). Tabela `user_view_settings`: wiersz per
  użytkownik, `settings jsonb`, RLS **inne niż w reszcie appki** — nie "wymaga logowania" (każdy
  zalogowany widzi wszystko), tylko `auth.uid() = user_id` w `using` I `with check`: to ustawienia
  prywatne, nikt nie zmienia widoku koledze. Bez Realtime i bez `activity_log` (dane jednej osoby).
- Kształt konfiguracji zna WYŁĄCZNIE appka (`src/lib/view/viewSettings.ts`), baza go nie waliduje —
  kolejna opcja widoku nie będzie wymagać migracji. Stąd `normalizeViewSettings()` na każdym
  odczycie (jsonb może zawierać cokolwiek: starsza wersja appki, ręczna edycja w SQL Editor).
  `order` = kolejność kolumn I JEDNOCZEŚNIE lista kolumn znanych w chwili zapisu: kolumna dodana
  później w kodzie ląduje na końcu i jest widoczna tylko, gdy należy do bloku `ladunek` — inaczej
  nowe pole samo wskakiwałoby wszystkim do widoku.
- `src/hooks/useViewSettings.ts` (odczyt + `upsert` z optymistycznym `setQueryData` — tabela
  przestawia się w tej samej klatce, w której kliknięto), `ViewSettingsDialog.tsx` (guzik
  "Widok (N/59 kolumn)" w pasku: checkbox per kolumna, strzałki ↑↓ na kolejność, "Zamroź pierwsze
  N", "Pokaż wszystkie", "Przywróć domyślne"; każda zmiana zapisuje się od razu, okno nie ma
  guzika "Zapisz"). Liczba zamrożonych kolumn BEZ sztywnego limitu — jedyna granica to liczba
  widocznych kolumn (właściciel od razu zapytał, czemu maksimum to 6; było arbitralne).
- **Po pierwszym teście właściciela ("te guziki ładunek/rozliczenie/fakturowanie/inne są
  niepotrzebne — daj każdemu wszystko i najwyżej będziemy sobie ręcznie wyłączać"):** przełączniki
  bloków USUNIĘTE z paska, domyślny widok to KOMPLET 59 kolumn, a kolumna dodana w kodzie później
  jest widoczna od razu (wcześniej: tylko z bloku `ladunek`). `BLOCK_LABELS` dalej służy jako
  podpis grupy przy każdej kolumnie w oknie "Widok".
- `supabase/migrations/0008_view_settings_show_all_columns.sql` + `0009_..._fix.sql` (obie
  ZAAPLIKOWANE przez MCP) zerują `hidden` w wierszach zapisanych PRZED tą zmianą — tam siedział
  stary zestaw domyślny (28 kolumn spoza "Ładunku"), którego nikt świadomie nie wybrał. Świadomie
  wąsko: tylko wiersze z DOKŁADNIE tym zestawem; czyjeś własne ukrycia zostają.
  **Pułapka: 0008 przeszła "z sukcesem", nie ruszając ani jednego wiersza.** Porównywała
  `array_agg(value order by value)` z ręcznie posortowaną tablicą, a `order by` na tekście używa
  collation bazy (en_US.UTF-8), które przy porównywaniu POMIJA podkreślenia — kolejność wyszła
  inna niż w sortowaniu ASCII. Wniosek: list kluczy nie porównywać przez sortowanie tekstu, tylko
  przez zawieranie jsonb w obie strony (`@>` i `<@`) — tak robi 0009. Złapane wyłącznie dlatego,
  że po `apply_migration` sprawdziłem stan wiersza zapytaniem, a nie poprzestałem na `success`.
- **Zamrażanie kolumn**: `position: sticky` z `left` czytanym ze zmiennych CSS `--frozen-left-N`,
  które ustawia `applyFrozenOffsets()` po pomiarze szerokości komórek NAGŁÓWKA. Dlaczego tak:
  (1) `left` musi być konkretną wartością — sticky nie umie "przyklej za poprzednią", a szerokości
  kolumn wynikają z treści, więc gdyby nie pomiar, trzeba by narzucić kolumnom stałe szerokości;
  (2) zmienne CSS zamiast stanu Reacta, bo `setState` w efekcie po każdym renderze kaskaduje
  rendery całej tabeli (eslint `react-hooks/set-state-in-effect` to zresztą wyłapał). Przeliczane
  też z `ResizeObserver` — tabela ma `w-full min-w-max`, więc przy wąskiej zawartości szerokości
  zależą od szerokości okna. Szerokości mierzone przez `getBoundingClientRect().width`, NIE
  `offsetWidth`: ten drugi zaokrągla do pełnych pikseli i przy kilkunastu zamrożonych kolumnach
  ułamki sumowały się w widoczne (1-2 px) przesunięcie — złapane testem w przeglądarce przy
  zamrożeniu 12 kolumn.
- **Pułapka do zapamiętania: `border-collapse` + kolumny sticky = znikające obramowania** (ramki
  siedzą wtedy na wspólnej siatce tabeli, nie na przesuwanej komórce). Tabela przeszła na
  `border-separate border-spacing-0`, a ramki wierszy MUSIAŁY przenieść się z `<tr>` na `<td>` —
  w trybie separate przeglądarka ignoruje obramowanie wiersza. Do tego wiersze mają jawne tło
  (`bg-white dark:bg-zinc-950`), a przyklejone komórki `bg-inherit`: bez tła treść przewijanych
  kolumn prześwitywałaby przez zamrożone, a `inherit` sprawia, że podświetlenie wiersza (hover,
  zaznaczenie) działa też na nich. Nagłówki dnia i kierunku (komórki `colSpan`) mają napis w
  `<div class="sticky left-2">`, żeby nie uciekał przy przewijaniu w bok.
- Zweryfikowane: logika — 25 przypadków (`scratch-viewsettings.test.mts`, plik tymczasowy, nie w
  repo: domyślny widok, własna kolejność, przycinanie `frozen`, kolumna dodana po zapisie,
  śmieci w jsonb, round-trip); przeglądarka (Playwright, `next dev`, tymczasowa strona
  `/test-widok` z mockiem i konfiguracją wstrzykniętą do cache TanStack Query) — po przewinięciu o
  700 px zamrożone kolumny i ich nagłówki stoją w miejscu i są sklejone bez dziury, niezamrożone
  odjeżdżają, nagłówek dnia zostaje przy lewej. Baza — REST PostgREST widzi tabelę (brak błędu
  cache schematu), zapis bez sesji odbity przez RLS (42501), `authenticated` ma komplet grantów.
  **NIE zweryfikowany z przeglądarki zapis na żywym koncie** (to środowisko nie ma konta do
  zalogowania) — pierwsze kliknięcie właściciela pokaże, czy upsert przechodzi.

**Szerokość kolumn per użytkownik — ZROBIONE** (klient: „obecny widok jest za szeroki, możemy jakoś
zwęzić dynamicznie? Ale żeby się dla każdego pracownika zapisywała szerokość"):
- **Bez migracji** — szerokości siedzą w tym samym `user_view_settings.settings` (jsonb) co kolumny,
  kolejność i zamrażanie; kształt konfiguracji zna wyłącznie appka. Nowe pole `widths` (klucz
  kolumny → px); BRAK wpisu = „auto", czyli dokładnie dotychczasowe zachowanie (szerokość z
  najdłuższej wartości). Stary wiersz bez `widths` czyta się normalnie.
- **Szerokość jest zmienną CSS na `<table>`** (`--cw-<kolumna>`), a nie stanem Reacta: w trakcie
  przeciągania uchwytu ustawiamy ją wprost na elemencie, więc przerysowuje się tabela w
  przeglądarce, a nie kilkaset komórek w Reakcie (ten sam wzorzec co `--frozen-left-N`).
- **PUŁAPKA: `width`/`max-width` NA KOMÓRCE nie działa przy `table-layout: auto`** — przeglądarka
  traktuje je jak sugestię i rozpycha kolumnę do treści. Dlatego szerokość dostaje WEWNĘTRZNY
  `<div>` (`overflow: hidden` + `text-ellipsis`), a `<td>`/`<th>` mają `p-0` i wypełnienie przeszło
  na ten div — dzięki temu zapisana liczba to szerokość CAŁEJ kolumny, tak samo w trybie odczytu
  jak z otwartym edytorem (wejście w edycję nie przesuwa reszty tabeli).
- UI: uchwyt na prawej krawędzi każdego nagłówka (przeciągnij = zwęź, dwuklik = z powrotem „auto"),
  a w oknie „Widok" sekcja „Szerokość kolumn": **„Zwęź wszystkie"** (110 px), **„Szerokości: auto"**
  i pole px przy każdej kolumnie. Zakres 48–640 px, przycinany przy zapisie I przy odczycie z jsonb.
  Dymek (`title`) z pełną wartością TYLKO w kolumnach z narzuconą szerokością — w kolumnie „auto"
  nic się nie przycina, więc byłby wyłącznie upierdliwy.
- **Dwa błędy złapane testem w przeglądarce, nie przy pisaniu:**
  1. „Zwęź wszystkie" ROZSZERZAŁO tabelę (5816 → 6719 px), bo kolumny naturalnie węższe od 110 px
     („Godz.", „ADR") dostawały 110 px. Poprawka: okno bierze z tabeli FAKTYCZNIE zmierzone
     szerokości (`measureColumnWidths` z `headerRefs`) i rusza tylko kolumny szersze od docelowej.
     Wniosek: „zwęź" musi porównywać się do tego, co widać, a nie do tego, co zapisane — kolumna
     bez wpisu nie znaczy „szeroka".
  2. Po nieudanym zapisie w pasku wisiał komunikat o błędzie mimo późniejszego udanego zapisu.
  Do tego nieudany zapis (np. brak sesji) COFA zmienną CSS ustawioną w trakcie przeciągania —
  inaczej kolumna zostawałaby zwężona tylko na tym ekranie, wbrew komunikatowi o błędzie.
- Zweryfikowane: logika — 23 przypadki (`scratch-widths.test.mts`, plik tymczasowy: normalizacja
  śmieci z jsonb, przycinanie zakresu, „zwęź" nigdy nie rozszerza, round-trip); przeglądarka
  (Playwright, `next dev`, tymczasowa strona `/test-widok` z mockiem i atrapą tabeli
  `user_view_settings`, bo w środowisku sesji nie ma konta) — 14 + 7 sprawdzeń: przeciąganie zwęża
  na żywo, tekst przycinany wielokropkiem, zamrożone kolumny przeliczają odsunięcia po zwężeniu,
  „Zwęź wszystkie" faktycznie zwęża tabelę, ręczna wartość i powrót do „auto".
  **NIE zweryfikowane na żywym koncie** — pierwszy zapis u właściciela pokaże, czy upsert przechodzi.

**Automatyczny odczyt zleceń ze skrzynki — ZBUDOWANY** (właściciel: „program śledzi maile — nawet
jak klient dośle informacje w treści/dodatkowym to program to zobaczy; nr zlecenia jest unikalny").

**PUŁAPKA NA STARCIE: to NIE jest Gmail, tylko Microsoft Exchange** (właściciel sprostował w trakcie
sesji; pierwsza wersja była pisana pod Gmaila po IMAP-ie). Skutek jest zasadniczy: **Microsoft
wyłączył Basic Auth dla IMAP-a w Exchange Online z końcem 2022**, więc wariant „login + hasło
aplikacji" tam NIE ZADZIAŁA. Zostaje **Microsoft Graph z uwierzytelnieniem APLIKACYJNYM** (client
credentials) — i jest to lepsze niż plan gmailowy: nic nie wygasa po 7 dniach, nie umiera przy
zmianie hasła użytkownika, nie trzeba trzymać niczyjego hasła. **NIEROZSTRZYGNIĘTE: czy klient ma
Exchange w chmurze czy lokalny** (właściciel odpowiedział „własna domena klienta jest", co pasuje do
obu). Dlatego źródło poczty jest WYMIENNE i obie ścieżki są gotowe.

- `supabase/functions/mail-poll/` — poller. `mailSource.ts` to wspólny interfejs źródła; `graph.ts`
  (Exchange Online, domyślne, `MAIL_SOURCE=graph`) i `imapSource.ts` + `imap.ts` (Exchange lokalny,
  `MAIL_SOURCE=imap`). Różnica między chmurą a serwerem kończy się na pobraniu wiadomości — cała
  reszta potoku jest wspólna, więc przełączenie to zmiana JEDNEJ zmiennej środowiskowej.
- **Kontrakt ten sam co przy ręcznym imporcie: NIC nie zapisuje się samo do `loads`.** Mail ląduje
  w kolejce „Skrzynka" jako PROPOZYCJA; zlecenie powstaje dopiero po kliknięciu dyspozytora
  (właściciel wybrał to wprost zamiast zapisu automatycznego). Pomyłka modelu nie wchodzi cicho do
  bazy ani na fakturę.
- **Kolejność odczytu — ta sama co w `ImportOrderDialog`, darmowe i pewne przed płatnym:**
  (1) prefiltr BEZ modelu (`relevance.ts`), (2) znany szablon regexem, (3) Claude. Mail, który nie
  przejdzie punktu 1, nie kosztuje ani grosza. Zakres wybrany przez właściciela: „tylko z
  załącznikiem PDF + odpowiedzi w wątku".
- **Jak realizowany jest wymóg „dośle informację w treści":** prefiltr przepuszcza maila bez
  załącznika, gdy (a) w temacie/treści stoi numer zlecenia z bazy — porównanie na formach
  znormalizowanych (`normalized_order_number` w SQL i `normalizeOrderNumber` w TS liczą TO SAMO), więc
  „ZD 1797-6 2026" trafia w „ZD/1797/6/2026"; albo (b) to odpowiedź w wątku już powiązanym ze
  zleceniem (Graph daje `conversationId`, IMAP `References`). Wtedy do modelu idzie sam tekst maila
  (ułamek kosztu PDF-a). Numery krótsze niż 5 znaków po normalizacji są pomijane, żeby „12/26" nie
  łapało przypadkowych liczb.
- **Szablony działają teraz TAKŻE serwerowo** (`pdfText.ts` — pdfjs w Deno, build „legacy", bez
  workera, `isEvalSupported: false`). Powód nie jest kosztowy tylko jakościowy: szablon jest
  deterministyczny, model probabilistyczny — wysyłanie do modelu dokumentu, który umiemy przeczytać
  regexem, byłoby cofnięciem się w dokładności. **Żeby regexy nie istniały w dwóch kopiach**
  (gwarantowany rozjazd przy pierwszej poprawce), źródłem prawdy zostaje `src/`, a
  `scripts/build-edge-shared.mjs` generuje kopię dla Deno do `supabase/functions/mail-poll/shared/`.
  **Odpalać ten skrypt po KAŻDEJ zmianie w `src/lib/orderTemplates/`, `src/types/parsedOrder.ts`,
  `src/lib/containers/tare.ts`, `src/lib/dates/workingDays.ts` — przed wdrożeniem `mail-poll`.**
- `parse-order-pdf` przyjmuje teraz `{ text }` obok `{ pdfBase64 }` — treść maila idzie przez TEN SAM
  schemat pól i ten sam prompt co dokument, zamiast drugiego zestawu reguł. Prompt ma regułę 11:
  mail niesie zwykle JEDNĄ informację, więc wypełnij tylko to, co faktycznie podaje (appka scala to
  z istniejącym zleceniem, więc zmyślona wartość byłaby realną szkodą).
- Migracje **0010** (`email_messages`, `email_attachments`, `email_ingest_state`, bucket
  `order-emails`, RLS, Realtime), **0011** (kursor niezależny od źródła — 0010 zakładała UID-y
  IMAP-owe, Graph używa znacznika czasu; kursor to teraz JEDNO pole tekstowe, którego kształt zna
  wyłącznie źródło) i **0012** (pg_cron co 2 min) — **WSZYSTKIE ZAAPLIKOWANE przez MCP**.
- Dedup stoi WYŁĄCZNIE na `UNIQUE (message_id)`. Dlatego kursor Graphowy porównuje `ge`, nie `gt`
  — lepiej powtórzyć wiadomość i odbić się o UNIQUE niż ją zgubić.
- UI: `SkrzynkaPanel.tsx` (panel boczny + licznik przy guziku „Skrzynka" w pasku),
  `useEmailInbox.ts` (Realtime, nazwa kanału z `useId()` — pułapka z ContractorsDialog),
  `useIngestState()`. **Martwy odczyt widać w panelu na czerwono** — sekret Microsoftu wygasa, zgoda
  administratora bywa cofana, a bez tego appka po prostu przestałaby dostawać zlecenia w ciszy.
  „Sprawdź teraz" wywołuje pollera poza harmonogramem (autoryzacja sesją dyspozytora).
  `ImportOrderDialog` dostał propy `initialParsed` (pola z maila, start od razu w „review") i
  `onSaved` (Skrzynka oznacza maila jako zaakceptowanego dopiero po UDANYM zapisie).

**Zweryfikowane, każde na prawdziwej ścieżce, nie na reprodukcji:**
- Edge Function ŁĄCZY SIĘ z `imap.gmail.com:993` (handshake 23 ms) — blokada portów w Supabase
  dotyczy tylko SMTP 25/465/587. Sprawdzone jednorazową funkcją próbną PRZED napisaniem klienta.
- `postal-mime` i `pdfjs-dist` działają w Deno na tym projekcie (też funkcją próbną, przed kodem).
- Klient IMAP: 5 testów przeciwko ATRAPIE SERWERA mówiącej protokołem (`imap.test.ts`) — literał
  `{N}` z CRLF w środku, strumień nierozjeżdżający się po FETCH, `UID SEARCH X:*` zwracające
  najwyższy UID mimo braku nowych, komunikat błędu logowania bez wycieku hasła.
- Prefiltr: 8 testów (`relevance.test.ts`).
- **Tryb tekstowy `parse-order-pdf` sprawdzony STRZAŁEM W PRODUKCJĘ** prawdziwą treścią maila
  („rozładunek przesuwamy na piątek 12.09 na 08:30"): model zwrócił numer zlecenia, kontener, nową
  datę i godzinę, spedytora z podpisu — i ZOSTAWIŁ RESZTĘ PUSTĄ, nie zgadł nawet kierunku.
- `deno check` + `next build` przechodzą.

**Czego NIE zweryfikowano: całej ścieżki od skrzynki** — nie ma jeszcze danych dostępowych do
Exchange'a. Pierwszy przebieg na żywej skrzynce jest przed nami.

**Do dokończenia przez administratora Microsoft 365** (właściciel: „nie mam, ale mam kogo poprosić"):
rejestracja aplikacji w Entra ID, uprawnienie **Mail.Read typu APPLICATION** (nie delegated) + zgoda
administratora, i — **to nie jest opcja, tylko wymóg** — `New-ApplicationAccessPolicy` zawężająca
aplikację do JEDNEJ skrzynki; bez tego Mail.Read na poziomie aplikacji daje dostęp do wszystkich
skrzynek w tenancie. Potem sekrety w Supabase (Project Settings → Edge Functions → Secrets):
`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MAILBOX_ADDRESS`, `INGEST_SECRET`; ten ostatni
TEN SAM ciąg także w Project Settings → Vault (stamtąd czyta go cron). Dla Exchange lokalnego zamiast
tego: `MAIL_SOURCE=imap` + `IMAP_HOST`/`IMAP_USER`/`IMAP_PASSWORD`.

**Do posprzątania:** tymczasowa funkcja diagnostyczna `probe-imap-tcp` na projekcie (nic nie robi,
nie ma sekretów) — MCP nie umie kasować funkcji, więc do usunięcia w Dashboard → Edge Functions.

**Nazwy terminali + BAF rozbity na stawkę bazową i dodatek (zgłoszenie właściciela po imporcie przez
Claude: „«Gdynia Container Terminal» to po prostu GCT — miejsce zdawania i pobierania kontenerów";
„w jednym zleceniu było, że stawka już jest z BAF 13% — wtedy program powinien, znając stawkę,
rozdzielić, ile wynosi stawka bazowa, ile BAF (przy wpisanym będziemy wypychać do faktur albo stawkę
z BAF razem, albo BAF jako oddzielną pozycję na fakturze — do konfiguracji via klient)"):**
- **Znaleziona przyczyna gubienia terminala: `matchPickupLocation` znało tylko skróty, a jej wynik
  NADPISYWAŁ wartość z modelu** (`parsed.pickup_type = matchPickupLocation(...)`), więc pełna nazwa
  z dokumentu nie tylko nie trafiała w listę, ale ZNIKAŁA bez śladu. Dwie poprawki naraz:
  `pickupLocations.ts` zna pełne nazwy (Gdynia Container Terminal → GCT, Baltic/Bałtycki Terminal
  Kontenerowy → BCT, Baltic Hub i DCT Gdańsk → BHub), a nierozpoznana wartość ZOSTAJE tekstem z
  dokumentu (formularz pokazuje ją jako dodatkową opcję).
- Normalizacja przeniesiona do `normalizeParsedOrder` (jedno miejsce dla przeglądarki i dla
  `mail-poll`) — call-site'y w `parseOrderPdf.ts` i `mail-poll/index.ts` już jej nie powtarzają.
  Doszedł `normalizeTerminalName` dla **miejsca zdania kontenera** (właściciel: GCT to też miejsce
  ZDAWANIA): skraca tylko wtedy, gdy CAŁA wartość jest nazwą terminala — „Depot Gdańsk, ul.
  Kontenerowa 7" zostaje w całości, bo `matchPickupLocation` (szuka fragmentu) skasowałaby adres.
- **BAF**: `src/lib/invoice/baf.ts` (`splitBaf`) liczy w obie strony — stawka Z BAF-em („3000, w tym
  BAF 13%" → baza 2654,87 + BAF 345,13) i BAF doliczany („2000 + 13%" → 2000 + 260). BAF liczony
  jako RÓŻNICA, nie osobnym mnożeniem, żeby dwie pozycje faktury sumowały się co do grosza do kwoty
  uzgodnionej ze spedytorem. `ParsedOrder` ma teraz `baf_percentage` i `rate_includes_baf`
  (`null` = „dokument nie mówi", liczymy jak doliczany — `false` to informacja, nie brak, więc
  `mergeParsedOrders`/`isEmpty` rozróżniają jedno od drugiego).
- `supabase/migrations/0013_baf_split_and_invoice_mode.sql` (**ZAAPLIKOWANA przez MCP** + `notify
  pgrst`): `loads.freight_base_amount` (arkusz miał %BAF, Kwotę BAF i SUMĘ — brakowało samej bazy) i
  `contractors.baf_invoice_mode` (`combined` domyślnie / `separate`). Zapis zlecenia wypełnia
  `freight_base_amount` + `baf_amount` + `total_amount` + `invoice_amount` (= kwota razem).
- Edycja inline: stawka bazowa, %BAF i SUMA to jedna zależność — zmiana którejkolwiek przelicza
  pozostałe (SUMA liczy w dół, baza w górę), a „Kwota" z bloku Fakturowanie idzie za nimi TYLKO
  dopóki faktura nie została wystawiona (potem jest zapisem tego, co poszło do Fakturowni).
- Okno faktury: przy `separate` jedno zlecenie daje DWIE pozycje (fracht + „Dodatek paliwowy BAF
  13% — kontener …"), przy `combined` jedną na kwotę razem. Po wystawieniu `invoice_amount` zlecenia
  to SUMA jego pozycji (wcześniej kod zakładał jedną pozycję na zlecenie).
- Funkcja `parse-order-pdf` **wdrożona przez MCP (v6)**: schemat ma `baf_percentage`/
  `rate_includes_baf`, prompt (zasada 5) każe przepisać kwotę TAK JAK STOI i nie liczyć BAF-u
  samemu, a opis `pickup_type` wymienia pełne nazwy terminali.
- **Zweryfikowane na produkcji, nie na reprodukcji**: dwa strzały curl-em w wdrożoną funkcję —
  „stawka 3000 zawiera BAF 13%" → `rate_amount 3000, baf_percentage 13, rate_includes_baf true`,
  `pickup_type` „GCT"; „2000 + BAF 13%" → `false`, terminal „Baltic Container Terminal" (appka sama
  sprowadza do BCT). Logika: 38 sprawdzeń (`scratch-baf.test.mts`, plik tymczasowy — rozbicie w obie
  strony, grosze, round-trip, terminale, scalanie `false`/`null`). Przeglądarka (Playwright, `next
  dev`, tymczasowa strona `/test-baf` z mockami): faktura `separate` = 2654,87 + 345,13 przy sumie
  3000, faktura `combined` = jedna pozycja 3000, formularz importu pokazuje rozbicie zdaniem pod
  polami. **NIE zweryfikowane na żywym koncie** (środowisko sesji nie ma konta) — pierwsze zlecenie
  z BAF-em u właściciela pokaże resztę.
- **UWAGA przy uruchamianiu skrzynki: `mail-poll` na produkcji jest DALEJ w wersji sprzed tej
  zmiany** (nie ma sekretów Exchange'a, więc i tak nie działa). Przed włączeniem odczytu maili
  wdrożyć ją ponownie — `supabase/functions/mail-poll/shared/` zostało już przegenerowane
  (`node scripts/build-edge-shared.mjs`), więc wystarczy samo wdrożenie.

**Leasing w gestii, plomba, „Data złożenia" (cut off), instrukcja zamiast miejsca zdania — kolejne
zgłoszenia właściciela z tej samej sesji:**
- **„Jeżeli w uwagach będzie Leasing, to wtedy gestia przestaw na Leasing"** — `src/lib/loads/
  leasing.ts`, reguła po stronie APPKI, nie w prompcie: działa tak samo przy szablonie znanego
  spedytora, przy odczycie przez Claude, przy mailu i przy ręcznym dopisaniu uwagi (formularz
  importu ORAZ edycja inline kolumny „Uwagi" — `buildPatch` dokłada wtedy `shipping_line`).
  Świadomie NADPISUJE gestię („przestaw"), a skasowanie uwagi jej NIE cofa — appka nie pamięta,
  co tam stało wcześniej, a dyspozytor i tak może wpisać swoje. Import dopisuje o tym ostrzeżenie
  w oknie, żeby podmiana armatora na „Leasing" nie zaskoczyła.
- **Numer plomby** — nowa kolumna `loads.seal_number` (migracja **0014**, ZAAPLIKOWANA przez MCP;
  w arkuszu klienta nie miała odpowiednika — „Nr ref." i „pin/booking" znaczą co innego). Pole w
  formularzu importu, kolumna „Nr plomby" w Zestawieniu, pole w schemacie funkcji.
- **„Złożone kiedy" → „Data złożenia"**, czytana ze zlecenia (w dokumentach zwykle „cut off").
  Zmieniła się TYLKO etykieta — nazwa kolumny `submitted_when` zostaje, bo siedzi w `activity_log`
  i w zapisanych ustawieniach widoku każdego użytkownika. Zostaje też TEXT-em, nie datą: cut off
  bywa z godziną („2026-09-20 12:00") albo warunkiem („cut off wg armatora”), a to jest informacja,
  po której planuje się dzień. Pole wchodzi do `ParsedOrder`, więc **merguje się** jak reszta —
  drugi dokument albo mail uzupełni je, jeśli pierwszy nie miał.
- **Miejsce złożenia pustego bywa INSTRUKCJĄ**, nie miejscem („zgodnie z instrukcjami armatora") —
  opis pola w funkcji mówi teraz wprost, żeby taką instrukcję przepisać zamiast zostawiać pustkę;
  `normalizeTerminalName` i tak jej nie rusza (skraca tylko wartość będącą samą nazwą terminala).
- Funkcja `parse-order-pdf` **wdrożona (v7)**: doszły `seal_number` i `submitted_when` (+ zasada 11
  o cut off, żeby nie mylić go z datą rozładunku ani terminem płatności).
- **Zweryfikowane na produkcji**: strzał w wdrożoną funkcję zleceniem eksportowym z plombą, cut
  offem, leasingiem i „zgodnie z instrukcjami armatora" — wszystkie pola odczytane poprawnie
  (`seal_number` PL0099887, `submitted_when` „2026-09-20 12:00", `submitted_where` instrukcja,
  `pickup_type` BHub, BAF 13% doliczany). Logika: 14 sprawdzeń (`scratch-leasing.test.mts`, plik
  tymczasowy). Przeglądarka (Playwright, tymczasowa strona `/test-leasing`): nowe pola wypełnione,
  a dopisanie uwagi „Kontener leasingowy" przestawiło gestię z MSC na „Leasing" na żywo.
- **Do sprawdzenia przy kolejnym PDF-ie Q4Road**: ich szablon (`q4road.ts`) nie czyta jeszcze
  plomby ani cut offu — nie mam pod ręką dokumentu, żeby zobaczyć etykiety, a zgadywanie regexa bez
  pliku to prosta droga do cichego błędu (patrz pułapka z kotwicą `$`). Do dopisania, gdy pojawi się
  zlecenie tego spedytora z tymi rubrykami.

**Rozpoznanie zlecenia po numerze + załączniki przy zleceniu (właściciel: „każde zlecenie jest
rozpoznawane do nr zlecenia — wtedy nie będzie potrzeby dodawać kolejnych dokumentów; jak wgramy
drugi dokument do tego samego zlecenia, to po prostu dociągną się brakujące dane"; „po imporcie
zleceń oryginalne PDF zostaną zachowane jako załączniki — analogicznie jak dogram POD/CMR/
potwierdzenie dostawy, program będzie dodawać także pole inne"):**
- **Numer zlecenia jako klucz.** `src/lib/loads/orderNumber.ts` — porównanie na formie
  znormalizowanej (same znaki alfanumeryczne, wielkie litery), więc „zd 1797-6 2026" trafia w
  „ZD/1797/6/2026". Ta sama reguła stała już w SQL (`public.normalized_order_number`, 0010) i w
  `mail-poll/relevance.ts` — teraz jest JEDNO źródło w `src/`, a kopia dla Deno jedzie przez
  `scripts/build-edge-shared.mjs` (relevance.ts re-eksportuje ją i próg `MIN_ORDER_NUMBER_LENGTH`).
- **Import nie tworzy duplikatu**: po odczycie dokumentów `ImportOrderDialog` szuka zlecenia o tym
  numerze wśród istniejących i wchodzi w tryb uzupełniania — zielony baner „Rozpoznane zlecenie
  …", guzik zapisu zmienia się na „Uzupełnij zlecenie …", a wartości JUŻ ZAPISANE wygrywają
  (dokument wypełnia tylko puste pola). Wyjście awaryjne: „Utwórz mimo to nowe zlecenie". Druga
  straż stoi przy ZAPISIE (numer bywa wpisany ręcznie po odczycie) — wtedy zamiast cichego insertu
  jest komunikat i ten sam wybór. Guzik „Dopnij PDF" przy wierszu ZOSTAJE, ale nie jest już
  konieczny.
- **Załączniki**: migracja **0015** (ZAAPLIKOWANA przez MCP) — tabela `load_documents` + prywatny
  bucket `load-documents` (polityki select/insert/update/delete dla `authenticated`, bo tu pisze
  przeglądarka, inaczej niż w `order-emails`, gdzie pisze tylko poller) + Realtime. Rodzaje:
  `zlecenie` / `list_przewozowy` / `pod_cmr` / `inne` (CHECK; etykiety w `src/types/loadDocument.ts`).
  KAŻDY wgrany przy imporcie plik jest zapisywany — także ten, którego nie udało się odczytać.
  Rodzaj zgadywany z nazwy pliku (`guessDocumentKind`; separatory `_ - .` zamieniane na spacje,
  bo bez tego „POD_podpisany.pdf" i „CMR_scan.pdf" nie łapały się w `\b`), do zmiany listą.
- Kolumna `bucket` w `load_documents` jest po to, żeby załącznik z maila (leży już w `order-emails`)
  dało się PODPIĄĆ zamiast kopiować — `SkrzynkaPanel` robi to po udanym zapisie (`onSaved` dostaje
  teraz `loadId`). Kasowanie dokumentu z bucketa maili usuwa tylko podpięcie, nie oryginał maila.
- Przy wierszu doszedł guzik **„Dokumenty (N)"** (`LoadDocumentsDialog`): lista z „Otwórz"
  (podpisany URL, bucket jest prywatny), zmiana rodzaju, usunięcie i wgranie kolejnych plików
  (POD/CMR/potwierdzenie/inne). Usunięcie ZLECENIA kasuje pliki z Storage PRZED usunięciem wiersza
  (`removeStoredFilesForLoad`) — `on delete cascade` sprząta tylko wiersze, do Storage Postgres nie
  sięga.
- **Zweryfikowane**: logika — 20 sprawdzeń (`scratch-dokumenty.test.mts`, plik tymczasowy:
  normalizacja numeru, dopasowanie, próg długości, zgadywanie rodzaju). Przeglądarka (Playwright,
  tymczasowa strona `/test-dokumenty`): wpisanie numeru w INNYM zapisie („zd 1797-6 2026") przy
  zapisie rozpoznaje istniejące zlecenie, podciąga jego spedycję i termin płatności, zostawia
  kontener z dokumentu, a „Utwórz mimo to nowe zlecenie" wraca do zwykłego zapisu. Baza — REST
  widzi `load_documents` (brak błędu cache schematu), insert bez sesji odbity przez RLS (42501).
  **NIE zweryfikowane na żywym koncie**: samo wgranie pliku do Storage i podgląd podpisanym URL-em
  (środowisko sesji nie ma konta) — pierwszy import u właściciela to pokaże.

**Numer zlecenia z członami w INNEJ KOLEJNOŚCI + kontener jako drugi sygnał** (zgłoszenie
właściciela: „na jednym zleceniu było nr KPB / 87, na drugim dokumencie 87 / KPB i program nie
połączył, a to to samo w sumie. Nr kontenera się pokrywa"):
- Dopasowanie po samej formie znormalizowanej dawało „KPB87" ≠ „87KPB". `src/lib/loads/
  orderNumber.ts` ma teraz `orderNumberLooseKey` — numer rozbijany na człony (po separatorach ORAZ
  na granicy litera↔cyfra, żeby „zd1797" znaczyło to samo co „ZD/1797"), człony sortowane, kolejność
  bez znaczenia.
- **PUŁAPKA złapana testem, nie przy pisaniu: bez dodatkowego warunku „TIIU218" (numer pisany jednym
  ciągiem) rozpadał się na TIIU + 218 i trafiał w wymyślone „218/TIIU".** Stąd reguła: przestawianie
  członów działa TYLKO, gdy dokument sam je rozdzielił separatorem — czyli dokładnie w przypadku
  zgłoszonym przez właściciela.
- `matchExistingLoad(loads, {order_number, container_number})` zastąpiło `findLoadByOrderNumber`:
  jeden punkt decyzji dla obu straży w `ImportOrderDialog` (po odczycie dokumentów i przy zapisie).
  Zwraca `confidence` (`exact` / `reordered` / `container`) ORAZ `auto` — czy appka scala sama:
  - `exact` → scala (jak dotąd); sprzeczny kontener nie blokuje, ale wchodzi do komunikatu,
  - `reordered` → scala, chyba że kontenery są SPRZECZNE (oba znane i różne),
  - `container` (numery różne, kontener ten sam) → **nigdy sam** — ten sam kontener wraca po
    tygodniach na inne zlecenie. Niebieski baner „Możliwe, że to zlecenie…" z guzikami „Uzupełnij
    zlecenie X" / „To inne zlecenie". Odrzucone skojarzenia trafiają do `dismissedMatches`, bo
    inaczej ta sama podpowiedź wracałaby przy każdym kliknięciu „Zapisz" i nie dałoby się utworzyć
    rekordu.
- Prefiltr maili (`mail-poll/relevance.ts`) dostał tę samą regułę przez `orderNumberVariants`
  (człony w każdej kolejności, sklejone — numery o >3 członach zostają przy jednej formie, bo 24
  warianty to już proszenie się o trafienie przypadkowe) ORAZ dopasowanie po numerze kontenera w
  treści maila (`index.ts` pobiera teraz `container_number`). Mail dalej trafia do Skrzynki jako
  propozycja, więc słabszy sygnał niczego nie psuje. `scripts/build-edge-shared.mjs` przegenerowany.
- **Zweryfikowane**: logika — 18 sprawdzeń (`scratch-match.test.mts`, plik tymczasowy: klucze,
  próg długości, pierwszeństwo `exact` nad kontenerem, „TIIU218"). Deno — 10 testów
  `relevance.test.ts` (doszły: przestawiony numer, kontener bez numeru zlecenia) + `deno check`.
  Przeglądarka (Playwright, `next dev`, tymczasowa strona `/test-dopasowanie` z mockiem zleceń,
  bo środowisko sesji nie ma konta): „87 / KPB" przy zapisie rozpoznaje zapisane „KPB / 87" i
  podciąga jego spedycję; inny numer + ten sam kontener daje propozycję, której appka NIE scala
  sama; „To inne zlecenie" nie blokuje kolejnego zapisu; nowe zlecenie bez wspólnych sygnałów
  przechodzi bez podpowiedzi.
- **UWAGA**: `mail-poll` na produkcji jest dalej w wersji sprzed tej zmiany (i sprzed BAF-u) — bez
  sekretów Exchange'a i tak nie działa; przed uruchomieniem skrzynki wdrożyć ją ponownie.

**Status kontenerów z Baltic Hub — ZBUDOWANE, ale BEZ DZIAŁAJĄCEGO TRANSPORTU** (właściciel: „Dla
kontenerów które podejmiemy z BHub sprawdzamy ich status na https://baltichub.com/dla-klienta/
sprawdz-kontener. SS/ZS/SO/SP/ZP + kolor. Waga brutto z terminala jest nadrzędna. Sprawdź ISOtype
(długość) i Gestię — zgadza się: pogrub, nie zgadza się: alarmuj. Co 15 minut w dni robocze 6-18,
tylko kontenery bez statusu ZP"):

- **BLOKADA, sprawdzona na trzech niezależnych ścieżkach, nie na reprodukcji: `baltichub.com` stoi
  za Cloudflare „managed challenge" i odrzuca wszystko, co nie jest przeglądarką na zwykłym łączu.**
  Zwykły `curl` z sesji → `403 cf-mitigated: challenge`; prawdziwy Chromium (Playwright) → utknął na
  „Cierpliwości…" i po 60 s challenge nie przeszedł; **jednorazowa Edge Function na TYM projekcie
  (`probe-baltichub`) → identyczne 403**. 403 wraca nawet na `/robots.txt`, więc blokada obejmuje
  całą domenę, nie sam formularz. Wniosek: **planowane „Edge Function + pg_cron" nie dosięgnie tej
  strony** — potrzebna jest usługa przechodząca przez Cloudflare albo oficjalne API terminala.
- **DRUGA PUŁAPKA, ważna przy wniosku o API: Supabase Edge Functions NIE MAJĄ stałego IP wyjścia.**
  Pięć kolejnych wywołań tej samej funkcji wyszło z pięciu różnych adresów AWS (98.93.11.29,
  18.209.87.207, 18.208.208.182, 54.234.64.220, 3.236.162.161) — potwierdza to też dokumentacja
  Supabase („Why Supabase Edge Functions cannot provide static egress IPs"). Jeśli Baltic Hub żąda
  IP do listy dozwolonych, **nie da się go podać z Supabase** — trzeba pośrednika ze stałym IP
  (mały VPS) albo odpytywać z komputera w biurze. Najpierw jednak warto spytać BHub, czy API w ogóle
  wymaga IP, czy wystarczy klucz.
- **Zbudowane i zweryfikowane (wszystko poza transportem i parserem strony):**
  - `src/lib/bhub/status.ts` — pięć kodów, etykiety, kolory (SS czerwony, ZS niebieski, SO żółty,
    SP pomarańczowy, ZP szary), `isFinalStatus` (ZP = koniec odpytywania). Kod wyprowadzany
    z DWÓCH faktów (gdzie stoi + czy wisi blokada), nie z dopasowywania napisów — pięć kodów to
    iloczyn dwóch osi. **Nierozpoznany status = `null` i surowy tekst w `bhub_status_raw`**,
    pokazywany dosłownie BEZ koloru (właściciel zapowiedział, że znaczenie kolejnych statusów będzie
    tłumaczył z czasem; kolor znaczyłby, że wiemy, co to jest).
  - `src/lib/bhub/isoType.ts` — **PUŁAPKA: kod ISO i zapis ze zlecenia czyta się INACZEJ.**
    W zleceniu „40HC"/„45" długość stoi wprost z przodu, w ISO 6346 długość niesie TYLKO PIERWSZY
    znak, a drugi to wysokość — więc `45G1` to 40 stóp high cube, NIE 45 stóp. Naiwne porównanie
    dwóch pierwszych cyfr uznałoby zlecenie na 45 stóp za zgodne z `45G1`, czyli zamilkłoby dokładnie
    tam, gdzie ma alarmować. Jest na to osobny test.
  - `src/lib/bhub/shippingLine.ts` — porównanie gestii z aliasami linii. Gestia „Leasing" (nasza
    własna wartość z reguły o uwagach) świadomie NIE jest porównywana — dawałaby stały fałszywy alarm.
  - `src/lib/bhub/schedule.ts` — okno pon-pt 6:00-18:00 **czasu warszawskiego** (nie UTC — inaczej
    latem odpytywanie chodziłoby 8-20 czasu terminala), polskie święta z tej samej listy co domyślna
    data zlecenia, `shouldTrackLoad` (BHub + numer + nie ZP).
  - `src/lib/bhub/cellDecoration.ts` — jedno miejsce na wygląd komórek: kolor statusu, pogrubienie
    przy zgodności, alarm (⚠ + czerwień) przy niezgodności, dymek mówiący CO się nie zgadza.
  - Migracja **0016** (ZAAPLIKOWANA przez MCP): kolumny `bhub_*` na `loads` + RPC
    `apply_bhub_check`. RPC, a nie zwykły UPDATE, z dwóch powodów: `app.actor` musi być ustawiony
    w TEJ SAMEJ transakcji (inaczej dziennik podpisze bota jako `bot:service_role`), a reguła
    „waga z terminala nadpisuje wszystko" ma siedzieć w jednym miejscu. Trigger dziennika pomija
    `bhub_checked_at` i `bhub_details` — bez tego KAŻDE odpytanie (co 15 min × każdy kontener)
    dopisywałoby wpis i utopiło prawdziwą historię.
  - Migracja **0017** (cron co 15 min) — **ŚWIADOMIE NIEZAAPLIKOWANA**: bez działającego transportu
    cron dzwoniłby tylko po to, żeby wpisać przy każdym zleceniu ten sam błąd.
  - `supabase/functions/bhub-status/` — **WDROŻONA (v2)**, `deno check` przechodzi. Źródło strony
    jest wymienne (`BHUB_SOURCE=direct|brightdata`, wzorzec `mailSource.ts`), adres strony
    w `BHUB_CONTAINER_URL`. Sprawdzona strzałem w produkcję: bez autoryzacji odmawia (401), zła
    metoda daje 405 — czyli wystartowała i chodzi po naszym kodzie.
  - **Transport: właściciel wybrał Bright Data Web Unlocker** (najtaniej dla ruchu z Cloudflare:
    ok. 1,5-3 USD za 1000 zapytań wobec ~7 u ZenRows i 75 kredytów/zapytanie u ScrapingBee).
    `BrightDataSource` woła `POST https://api.brightdata.com/request` z `{zone, url, format:"raw"}`
    i Bearer tokenem — kontrakt sprawdzony w dokumentacji Bright Daty, nie z pamięci.
    **BRAKUJĄ TRZY SEKRETY** (Project Settings → Edge Functions → Secrets): `BHUB_SOURCE=brightdata`,
    `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_ZONE` (nazwa strefy typu Web Unlocker). Do tego czasu appka
    pokazuje wprost, czego brakuje, zamiast po cichu nic nie robić.
  - **Tryb podglądu bez zapisu**: `POST /functions/v1/bhub-status` z `{"probeContainer":"OMTU2301120"}`
    (tokenem zalogowanego użytkownika) pobiera stronę i zwraca, co z niej wyszło, NIE dotykając
    ani jednego zlecenia — do sprawdzenia, czy `BHUB_CONTAINER_URL` jest właściwy.
  - UI: kolumna „Status BHub" przy numerze kontenera, guzik „Statusy BHub (N)" w pasku, znaczek
    kręcący się przy numerze kontenera w trakcie sprawdzania, sprawdzenie odpalane automatycznie
    po zapisaniu zlecenia (`onSaved`). Edycja statusu listą pięciu kodów (w bazie jest CHECK).
- **Błąd złapany PRZED wdrożeniem, zapytaniem do bazy zamiast założeniem:** `to_char(24000,
  'FM9999999990.99')` zwraca **„24000." z kropką na końcu** — taki zapis nie tylko brzydko wygląda
  w kolumnie „Waga brutto", ale przestaje pasować do wzorca „czysto liczbowej wagi"
  w `canOverwriteGrossWeight`, więc appka wzięłaby go za ręczny tekst. Naprawione
  `trim(trailing '.')`.
- **Błąd złapany testem, nie przy pisaniu:** aliasy armatorów były zapisane w formie sklejonej
  („mediterraneanshipping"), a normalizacja wycina z prawdziwego tekstu słowa „Shipping"/„Company" —
  więc „Mediterranean Shipping Company" NIGDY nie trafiało w „MSC". Warianty zapisujemy teraz
  dosłownie (ze spacjami) i normalizuje je ten sam kod; jest test-straż na tę klasę błędu.
  Przy okazji „ZIM Sp. z o.o." wychodziło jako „ZIMZOO”, bo po sklejeniu spacji „z o.o." zamienia
  się w „zoo”, którego granice słów z listy szumu już nie widzą — formy prawne zdejmowane są teraz
  PRZED sklejeniem.
- **Zweryfikowane:** logika — 47 sprawdzeń (`scratch-bhub.test.mts`, plik tymczasowy). Baza — RPC
  odpalony na ŻYWEJ bazie w transakcji cofniętej wyjątkiem: waga `24000` bez kropki nadpisała
  `22200` ze zlecenia, aktor w dzienniku to `bot:baltichub`, **powtórne identyczne sprawdzenie NIE
  dopisało wpisu** (pomijanie `bhub_checked_at` działa), a zmiana statusu dopisała; po cofnięciu
  nie zostało ani jedno zlecenie, wpis ani śmieciowa migracja. Nazwy parametrów RPC zgodne z tym,
  co wysyła funkcja; filtr PostgREST „wszystko poza ZP" sprawdzony strzałem w REST (HTTP 200).
  Przeglądarka (Playwright, `next dev`, tymczasowa strona `/test-bhub`) — 25 sprawdzeń: pięć
  kolorów faktycznie różnych i o właściwej barwie, dymek z wagą/ISO/czasem, pogrubienie przy
  zgodności, alarm „⚠" z wyjaśnieniem przy 45 vs `45G1`, „Leasing" bez oceny, nieznany status bez
  koloru, znaczek pojawia się PRZY NUMERZE KONTENERA na czas sprawdzenia i znika po nim, guzik
  liczy 9 z 10 (ZP pominięty). **UWAGA na Tailwind 4: `getComputedStyle` zwraca kolory jako
  `lab(...)`, nie `rgb(...)` — asercje na napis „rgb(" cicho nie przechodzą.**
- **Czego NIE zweryfikowano i czego brakuje:**
  1. **Pierwszego przebiegu przez Bright Datę** — sekrety wpisuje właściciel, więc nikt jeszcze nie
     pobrał tą drogą ani jednej strony. Dopóki to nie przejdzie, nie wiadomo nawet, czy domyślny
     `BHUB_CONTAINER_URL` jest właściwym adresem (formularz może wysyłać POST, nie GET).
  2. **Parsera strony** (`supabase/functions/bhub-status/parse.ts`) — układu strony NIE WIDZIAŁEM
     ani razu. Parser jest napisany tak, żeby pierwsze prawdziwe uruchomienie samo powiedziało, jak
     stronę czytać: wyciąga WSZYSTKIE pary etykieta→wartość, komplet zapisuje do
     `loads.bhub_details`, a nazwy rubryk, które nas interesują, siedzą w jednym słowniku `LABELS`
     do uzupełnienia po pierwszym przebiegu. **Nie dopisywać tam regexów pod niewidzianą stronę** —
     to dokładnie ta pułapka, co z kotwicą `$` w q4road.
  3. Czterech przykładowych kontenerów właściciela (OMTU2301120, MBUU1000292, CAAU2300808,
     MSBU3460867) nie dało się sprawdzić — strona nie odpowiada z tego środowiska.
- **Do posprzątania w Dashboardzie** (MCP nie kasuje funkcji): `probe-baltichub` (zagłuszona do
  HTTP 410 i z powrotem za `verify_jwt`, bo pierwsza wersja przyjmowała dowolny adres w zapytaniu,
  czyli była otwartym pośrednikiem) oraz `probe-imap-tcp` z poprzedniej sesji.

**Do zrobienia w kolejnej sesji:**
0. Kolejne przykłady zleceń od nowych spedytorów — po każdym sprawdzić, czy Haiku 4.5 nadal daje
   radę (jeśli nie: `MODEL` → `claude-sonnet-5`), i czy któryś spedytor powtarza się na tyle często,
   żeby opłacał się deterministyczny szablon zamiast płatnego odczytu.
2. Więcej przykładów zleceń od innych spedytorów → kolejne pliki w `src/lib/orderTemplates/`
   (wzorzec: `detect` po nagłówku dokumentu + nazwie spedytora, `parse` etykieta→etykieta przez
   `between()`, nigdy `$`).
3. Kontrola kosztu odczytu przez Claude, jeśli okaże się potrzebna (dziś funkcja jest dostępna dla
   każdego zalogowanego, bez limitu wywołań) — świadoma decyzja do podjęcia z właścicielem, nie
   kopiować `is_manager()` z DAB bez pytania.
4. Edycja inline: nawigacja Tab/strzałkami między komórkami, jeśli dyspozytorzy o to poproszą.
6. Widok: przeciąganie nagłówków (dziś kolejność ustawia się strzałkami w oknie "Widok") i
   ewentualnie nazwane widoki do przełączania ("Dyspozytor", "Fakturowanie") — konfiguracja jest
   już obiektem w jsonb, więc jedno i drugie da się dołożyć bez migracji. Do zrobienia dopiero,
   gdy właściciel powie, że tego chce.
5. Dla eksportu: domyślna data liczy się dziś od `delivery_date` (jedyna data z szablonu Q4Road, tam
   "Miejsca rozładunku"). Gdy pojawi się zlecenie eksportowe z datą ZAŁADUNKU, upewnić się, że parser
   szablonu wpisuje ją tak, żeby "dzień roboczy przed" liczył się od właściwej daty.
7. **Baltic Hub — dokończenie** (patrz sekcja wyżej): po wybraniu transportu przez właściciela
   uzupełnić `source.ts`, wdrożyć `bhub-status`, przejść przez pierwsze prawdziwe sprawdzenie,
   z `bhub_details` odczytać faktyczne nazwy rubryk i dopisać je do `LABELS` w `parse.ts`, dopiero
   potem zaaplikować migrację 0017 (cron). Przy okazji dopytać właściciela o znaczenie statusów,
   których strona pokaże więcej niż pięć ustalonych („z czasem będę Ci tłumaczył").
