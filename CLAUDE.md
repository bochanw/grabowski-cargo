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
  **SPROSTOWANIE (sesja z Planem wspaniałym, sprawdzone zapytaniem do `fleet_store`): rekord
  kierowcy MA pole `phone`** — tylko jest puste u obu kierowców, więc appka dalej bierze telefon z
  dokumentu. Gdyby właściciel zaczął je wypełniać, `reconcileWithFleet` warto o nie rozszerzyć.
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

**Baltic Hub — co ustalone NA ŻYWO (ta sama sesja, po podłączeniu Bright Daty):**
- **Transport DZIAŁA.** Bright Data Web Unlocker przechodzi przez Cloudflare (sekrety
  `BHUB_SOURCE=brightdata`, `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_ZONE=web_unlocker1` wpisał
  właściciel). Zmierzone: **jedno pobranie trwa ~25 s**. Pierwsza wersja pytała o kontenery po
  jednym i funkcja brzegowa wyczerpała czas życia po TRZECIM z pięciu — a urwana funkcja nie
  zapisuje błędu, więc dwa zlecenia zostały bez sprawdzenia I BEZ ŚLADU.
- **Jak naprawdę pyta się o wyniki** (z podglądu zakładki Sieć u właściciela, nie ze zgadywania):
  `POST https://baltichub.com/multi` z ciałem `lang=pl&id[]=NR1&id[]=NR2…`. Sam adres
  `/dla-klienta/sprawdz-kontener` zwraca WYŁĄCZNIE formularz — pole na kontenery buduje JavaScript,
  więc w źródle strony go nie ma (appka zapisała stamtąd tylko przyciski od ciasteczek) i żaden
  adres z numerem w parametrze nie mógł zadziałać. Kosztowało to dwie rundy.
- **`id[]` powtórzone = jedno zapytanie na wiele kontenerów.** Stąd pobieranie PACZKAMI po 10
  (`BATCH_SIZE`): przy 25 s i koszcie za zapytanie pytanie po jednym było dziesięć razy dłuższe
  i dziesięć razy droższe za tę samą odpowiedź.
- **BLOKADA, aktualna: `/multi` odpowiada stroną „Page Expired" (Laravel, 419 = wygasły token
  CSRF).** Zapytanie dochodzi pod właściwy adres i we właściwej formie, ale serwis wymaga tokenu
  z `<meta name="csrf-token">` POBRANEGO WCZEŚNIEJ ze strony i odesłanego razem z ciasteczkiem
  sesji. Bright Data Web Unlocker traktuje każde zapytanie osobno, a własne nagłówki/ciasteczka
  wymagają trybu, który przestawia rozliczenie na „płacisz też za nieudane zapytania" — świadomie
  odrzucone. **Drogi wyjścia: (a) eksport XLSX, jeśli okaże się GET-em (Laravel nie wymaga tokenu
  przy GET), (b) Bright Data Scraping Browser (~8 USD/GB, prawdziwa przeglądarka klika sama;
  do sprawdzenia, czy da się nim sterować z Edge Function).**
- **Znaczenie pól — z DOKUMENTACJI TERMINALA** (sekcja „Opis elementów karty kontenera" na stronie
  sprawdzania kontenera), nie z domysłu: `Weight [KG]` = **waga VGM**, `Cargo Weight` = VGM minus
  tara, `Commodity Weight` = waga dla Urzędu Celnego. **`T-State` ma OSIEM wartości: Inbound
  (w drodze na terminal), Yard, EC/In, EC/Out, Departed, Loaded, Advised, Retired — NIE MA
  „Vessel"**, której szukała pierwsza wersja kodu, więc kontener w drodze nie dostawał statusu.
  Odpowiednik „na statku" to `Inbound`. Stany „kontenera już tu nie ma" nie dostają żadnego
  z pięciu kodów — **do ustalenia z właścicielem, jak je oznaczać**.
- **Trzy błędy złapane na żywych danych, wszystkie z testami-strażami:** (1) wzorzec kodu ISO był
  tak szeroki, że łapał angielskie słowa ze strony — do bazy trafiły „LINK" i „LEFT" jako typ
  kontenera (przy dopuszczonym „M" przechodziło nawet „MENU"); (2) te śmieci NIE DAŁY SIĘ USUNĄĆ,
  bo zapis szedł przez `coalesce(nowa, stara)` — migracja **0018** wprowadza jawny `p_parsed`
  i czyści błędne wpisy; (3) pusta odpowiedź Bright Daty (200, zero znaków) udawała „stronę bez
  danych" — teraz to jawny błąd z adresem, a do `bhub_details` zawsze trafia `_adres`,
  `_dlugosc_odpowiedzi` i `_paczka`.
- Funkcja `bhub-status` wdrożona (v10). **Repo jest o jeden commit do przodu** (słownik T-State +
  nazwanie „Page Expired") — do wdrożenia razem z rozwiązaniem transportu.

**KONIEC drogi serwerowej — statusy Baltic Hub odpytuje ROZSZERZENIE DO CHROME**
(**CZĘŚCIOWO NIEAKTUALNE — dotyczy WYŁĄCZNIE Baltic Huba. BCT i GCT wróciły na serwer, bo są
publiczne; patrz sekcja „BCT i GCT ODPYTUJE SERWER" na końcu pliku. Wszystko poniżej o Cloudflare,
reCAPTCHY i `chrome.debugger` obowiązuje dalej — dla BHuba.**) (właściciel:
„chyba nie przejdziemy tego problemu z weryfikacją, możemy spróbować zrobić to przez przeglądarkę
dopóki nie rozwiążę problemu z API? inni operatorzy terminali będą również się bronić, a tam API
nie będzie na bank"; przy okazji wybrał: Bright Datę **usunąć całkiem**):

- **Ostatni błąd starej drogi, dla porządku**: przebieg 2026-09-03 15:25 UTC (64 s) utknął na
  przejściówce Cloudflare — tytuł „Just a moment…", treść „Performing security verification",
  zero formularzy, więc nasze 25 s czekania na pole minęło, zanim weryfikacja się skończyła.
  To etap WCZEŚNIEJSZY niż wszystkie poprzednie błędy: przebieg 22 minuty wcześniej przechodził
  Cloudflare bez problemu i wykładał się dopiero na braku wyników (stąd wykrycie reCAPTCHY).
  Czyli nie twarda blokada, tylko loteria — i to ona przesądziła o zmianie drogi.
- **Uratowany kod, którego NIE BYŁO w repo**: wdrożona wersja `bhub-status` (v31) była nowsza niż
  HEAD i niosła ustalenia z produkcji, których nie miał żaden commit (`git log --all -S` nic nie
  znajdowało): solver Bright Daty odpowiadał `solve_finished`, formularza wysyłającego na `/multi`
  na tej stronie NIE MA (numery wysyła JavaScript), a kolejność korków to Cloudflare → zgoda na
  ciasteczka → reCAPTCHA → pole i guzik. Ściągnięte z projektu przez MCP i przeniesione do
  `extension/page.js`. **Wniosek: nie wdrażać z niezacommitowanego drzewa.**

- **Podział pracy** (to jest cała zmiana): rozszerzenie otwiera stronę terminala w prawdziwej
  przeglądarce dyspozytora, wpisuje numery i czyta wynik; funkcja `bhub-status` mówi tylko, o co
  pytać (`pending`), rozumie odpowiedź (`parse.ts` bez zmian) i zapisuje ją przez `apply_bhub_check`
  (`report`) oraz pilnuje, żeby martwy odczyt było widać (`heartbeat`). Reguły odczytu ZOSTAJĄ na
  serwerze — poprawka nie wymaga wtedy aktualizacji rozszerzenia na każdym komputerze.
- **Usunięte**: `source.ts`, `browser.ts`, `wsClient.ts`, `src/lib/supabase/checkBhubStatus.ts`,
  migracja `0017` (cron — nigdy nie zaaplikowana; na serwerze nie ma już czego uruchamiać).
  Do posprzątania po stronie właściciela: sekrety `BHUB_SOURCE`, `BRIGHTDATA_API_TOKEN`,
  `BRIGHTDATA_ZONE` (Dashboard → Edge Functions → Secrets) i funkcje próbne `probe-baltichub`,
  `probe-imap-tcp`, `probe-websocket` (MCP nie kasuje funkcji).
- `extension/` — gotowe rozszerzenie MV3, **bez budowania i bez zależności** (katalog wgrywany
  przez „Załaduj rozpakowane"). Stały identyfikator `jaiopbejoakjdggjpkgoambeifcjjffj` bierze się
  z klucza publicznego w `manifest.json` — dzięki temu appka wie, do kogo mówić, i nie zmienia się
  to przy ponownym wgraniu. `externally_connectable` wpuszcza WYŁĄCZNIE
  `grabowski-cargo.fleetprofit.eu` (i adres gałęzi na Netlify). Instrukcja dla dyspozytorów:
  `extension/README.md`.
- **Kilku dyspozytorów**: wystarczy JEDEN włączony komputer — wynik jest wspólny (baza + Realtime).
  Żeby dwie włączone przeglądarki nie pytały terminala o to samo, `pending` pomija kontenery
  sprawdzone w ciągu ostatnich 10 minut (próg krótszy niż kwadrans odpytywania, więc nie opóźnia
  cyklu); prośba o KONKRETNE zlecenia ten próg pomija, bo człowiek, który pyta, ma dostać odpowiedź.
- Migracja **0019** (`bhub_agent_state`, ZAAPLIKOWANA przez MCP + `notify pgrst`): kto i kiedy
  ostatnio sprawdzał. RLS tylko na SELECT dla `authenticated` — pisze wyłącznie funkcja. W pasku
  Zestawienia stan świeci na zielono/pomarańczowo/czerwono (`src/lib/bhub/agentStatus.ts`), przy
  czym **brak rozszerzenia w TEJ przeglądarce nie jest alarmem, jeśli sprawdza ktoś inny** — to
  rozróżnienie ma osobny test.
- Zagadki i weryfikacje, których automat nie kliknie, kończą się POWIADOMIENIEM Chrome („Baltic Hub
  czeka na Ciebie") i przerwaniem przebiegu — reszta zleceń zachowuje stary `bhub_checked_at`, więc
  w następnym przebiegu stoi pierwsza w kolejce.
- **Pułapka MV3 do zapamiętania**: service worker usypia po ~30 s bezczynności, ale każde wywołanie
  API rozszerzenia ten czas resetuje. Pętle czekania odpytują stronę `chrome.scripting` co 1,5 s
  i dlatego żyją; zamiana tego na samo `setTimeout` zaczęłaby gubić przebiegi w połowie.
- **Zweryfikowane**: `page.js` w PRAWDZIWYM Chromium na stronie odwzorowującej zmierzone pułapki
  terminala — 25 sprawdzeń (`scratch-page.test.mjs`, plik tymczasowy): pole bez `name/id/placeholder`
  i poza formularzem, dwie wyszukiwarki `GET /search`, radio `seacontainer` (nietknięte), nawigacja
  „Sprawdź kontener online" i nagłówki tabeli jako fałszywe guziki, „Odrzuć wszystkie" NIE klikane,
  przejściówka Cloudflare rozpoznana jako niegotowa, widoczna reCAPTCHA odróżniona od braku wyników.
  Całe rozszerzenie wgrane do Chrome — 15 sprawdzeń (`scratch-ext.test.mjs`): manifest się wczytuje,
  identyfikator wychodzi ten, którego szuka appka, alarm 15-minutowy istnieje, wiadomości chodzą,
  a przebieg bez logowania wraca z czytelnym powodem (nie wyjątkiem). Stan w pasku — 15 sprawdzeń
  (`scratch-agent.test.mts`). Do tego `deno check`, `next build`, filtr PostgREST z dwoma `or=`
  sprawdzony strzałem w REST (HTTP 200). **Rozszerzenia wczytuje tylko NOWY headless Chrome'a
  (`channel: "chromium"` w Playwrightcie) — stary ignorował je po cichu.**
- **NIE zweryfikowane na żywym terminalu**: to środowisko nie ma konta ani dostępu do baltichub.com.
  Pierwsze uruchomienie u właściciela pokaże, czy strona daje się obsłużyć bez zagadki i czy
  `parse.ts` czyta karty z widocznego tekstu tak samo, jak czytał je z HTML-a Bright Daty.

**Rozszerzenie URUCHOMIONE u właściciela — co się okazało na żywym terminalu (wersje 1.0.0-1.0.8):**
- **NAJWAŻNIEJSZE USTALENIE: `element.click()` i `input.value = ...` NIE WYSTARCZAJĄ.** Zdarzenia
  z JavaScriptu mają `isTrusted === false`, więc reCAPTCHA na stronie terminala nigdy nie rusza i
  formularz leci pusty — strona odpowiada „Brak wyników". Wpisywanie i klikanie idzie teraz przez
  **`chrome.debugger` (CDP)**: `Input.dispatchMouseEvent` + `Input.insertText` (`extension/input.js`),
  czyli zdarzenia nie do odróżnienia od ludzkich. Dlatego w `manifest.json` jest uprawnienie
  `debugger` i dlatego Chrome pokazuje pasek „rozszerzenie debuguje tę kartę" — to koszt wejścia,
  nie usterka. Zweryfikowane wprost: ten sam formularz kliknięty po staremu zwraca „Brak wyników",
  a kliknięty przez CDP zwraca kartę kontenera.
- **Jeden kontener na zapytanie** (`config.js`, `rozmiarPaczki: 1`). Tryb wielu numerów naraz jest
  u terminala oznaczony jako „wersja testowa" i przez automat zwracał „Brak wyników", mimo że
  właściciel wkleił tę samą listę ręcznie i dostał trzy karty. Nie warto było walczyć — pytanie po
  jednym działa, a kwadrans na cykl i tak wystarcza.
- **Trzy pułapki „kliknięty nie ten guzik", wszystkie złapane przez właściciela na żywo:**
  1. Okno zgody na ciasteczka (CookieYes) — pierwszy `<button type=submit>` na stronie to
     „Dostosuj". Stąd `wOknieZgody()` (odrzuca kontenery `cky/cookie/consent/gdpr/rodo` i
     `role=dialog`) i osobne zamykanie zgody (`.cky-btn-accept`), z jawnym zakazem klikania
     „Odrzuć wszystkie".
  2. „Sprawdź statki przy kei" — nagłówki tabeli i kafelki nawigacji wyglądają jak guziki.
     `znajdzGuzik()` szuka DWOMA przebiegami (najpierw dokładna etykieta, potem luźno) i ma listę
     `ZAKAZANE` (`dostosuj|odrzu|ustawienia|online|statk|kei|terminal na żywo|awizacj|...`).
  3. Pole wyszukiwania kontenera nie ma `name`, `id` ani `placeholder` i stoi POZA formularzem —
     wybierane jest od pola „w dół", nie po pierwszym inpucie na stronie.
- **Migawka strony obcięta do 300 znaków** — `wyniki()` rozsypywało obiekt z `opiszStrone()`, który
  ma własny, skrócony klucz `tekst`, i nadpisywało nim pełną treść. Pełny tekst musi iść JAKO
  OSTATNI klucz. Objaw był mylący: „program dalej wiesza się na tym samym", bo serwer dostawał za
  mało tekstu, żeby cokolwiek sparsować.
- **Poprawne wyniki bywały wyrzucane** (właściciel: „prawidłowe wartości były zwracane, tylko
  zamiast je zapisać szedłeś dalej"). Przebieg czekał na dowolną zmianę strony, a nie na
  ODPOWIEDŹ O NASZ KONTENER. `extension/odpowiedz.js` (`odpowiedzDotyczyNas`) sprawdza teraz, czy
  w treści stoi „Karta kontenera" albo numer, o który pytaliśmy; do tego 3 s odczekania po
  zamknięciu zgody (reCAPTCHA musi się rozgrzać) i jedna ponowna próba.
- **ISO Type na oznaczenie klienta** (właściciel: „mogłeś pobrać ISO Type 22G1 i zamienić na 20 —
  to jest ich oznaczenie"): `isoToOrderSize()` w `src/lib/bhub/isoType.ts`, migracja **0020**.
  **Straż na kształt kodu ISO (`/^[24L][0-9CDEF][ABGHKNPRSTUV][0-9A-Z]$/`) nie jest ozdobą** —
  bez niej angielskie słowo „LINK" ze strony przechodziło jako typ kontenera i dawało „45".
- **Gestia z terminala** — migracja **0021**. Obie (0020 i 0021) wypełniają pole TYLKO, gdy jest
  puste (`coalesce(nullif(trim(...), ''), p_...)`): zlecenie jest źródłem prawdy, terminal
  uzupełnia brak. Wyjątkiem zostaje waga brutto, która wg właściciela nadpisuje wszystko.
- **Ponowne sprawdzenie zlecenia ze statusem ZP**: `pending` z jawną listą `loadIds` pomija
  WSZYSTKIE filtry cyklu (ZP, próg 10 minut, `pickup_type`) — człowiek, który prosi o konkretne
  zlecenie, ma dostać odpowiedź. Cykl automatyczny dalej omija ZP, bo to stan końcowy.
- `bhub-status` wdrożona (v37).

**KILKA KONTENERÓW W JEDNYM PRZEBIEGU — naprawiony wyścig z wczytywaniem strony (wtyczka 1.0.9;
zgłoszenie właściciela: „odczytuje bezbłędnie za 1 razem jak zaznaczę pojedynczy ładunek, gubi się
jak ma sama sprawdzić kilka"):**
- **Przyczyna: `chrome.tabs.update` tylko ZLECA wejście na stronę i wraca od razu**, a rozszerzenie
  sprawdzało potem wyłącznie, czy adres karty pasuje do hosta terminala. Stary dokument — ten
  z wynikami POPRZEDNIEGO kontenera — ma dokładnie ten sam adres i wciąż ma pole na numery, więc
  warunek spełniał się NATYCHMIAST, jeszcze przed nawigacją. Pytamy po jednym kontenerze
  (`rozmiarPaczki: 1`), w tej samej przypiętej karcie, więc od drugiego kontenera cała robota szła
  na stronie, która za chwilę znikała. Przy pierwszym nie było czego pomylić (karta dopiero
  powstawała) — i dlatego pojedyncze sprawdzenie zawsze wychodziło bez pudła.
- Skutki były DWA, zależnie od tego, kiedy dojechała nawigacja: numer przepadał razem ze starą
  stroną (60 s czekania na wyniki, których nikt nie zamówił) albo do serwera szła KARTA
  POPRZEDNIEGO kontenera — a `parse.ts` nie znajdował w niej naszego numeru i przy zleceniu
  lądowało „nie rozpoznałem odpowiedzi Baltic Hub".
- **Naprawa 1 — stary dokument jest ZNACZONY przed nawigacją** (`page.js: oznaczStary`, znacznik
  na `documentElement`, więc świeży dokument go nie ma), a `wejdzNaStrone` czeka na dokument BEZ
  znacznika, wczytany do końca i pod właściwym adresem. Gdyby nawigacja w ogóle się nie zaczęła —
  jedno wymuszone przeładowanie, potem czytelny błąd z migawką.
- **Naprawa 2 — `odpowiedzDotyczyNas` wymaga NASZEGO numeru**, a nie „jakiejkolwiek karty
  kontenera". Warunek jest teraz dokładnie tym, czego wymaga `parse.ts` po stronie serwera
  (`wytnijKarte` szuka „Unit Nbr: <numer>"), więc czekanie dalej nic nie kosztuje, a bez tego
  cudza karta uchodziła za odpowiedź. Numer dopasowywany z odstępami między znakami — terminal
  pisze „OMTU 2301120", a `innerText` nie zawiera wartości pól formularza, więc wpisany przez nas
  numer nie może się podszyć pod odpowiedź.
- Przy okazji: ponowna próba (`proba < 2`) była MARTWYM KODEM — stała za warunkiem, który w tym
  miejscu zawsze był spełniony. Stoi teraz tam, gdzie ma sens: strona odpowiedziała, ale nie o nas
  (puste zapytanie, reCAPTCHA nie zdążyła) → drugie podejście na świeżej stronie zamiast błędu.
- **Zweryfikowane w PRAWDZIWYM Chrome, na całej drodze** (`scratch-wiele.test.mjs`, plik
  tymczasowy): atrapa terminala wierna w tym, co decyduje o błędzie — wyniki pojawiają się w tej
  samej stronie i na niej ZOSTAJĄ, a wczytanie trwa 6 s (u właściciela robi to Cloudflare).
  Podstawione WYŁĄCZNIE otoczenie (strona i Supabase); background.js, page.js, odpowiedz.js
  i input.js biegną te same, co u dyspozytora — łącznie z pisaniem przez `chrome.debugger`.
  15 sprawdzeń: trzy zlecenia, każde dostaje odpowiedź o SWOIM kontenerze i w żadnej nie ma karty
  cudzego, nieznany kontener wraca jako „brak wyników" (nie jako błąd), „Odrzuć wszystkie"
  w oknie ciasteczek nietknięte. **Test sprawdzony też odwrotnie**: na kodzie sprzed poprawki
  pierwszy kontener przechodzi, a drugi i trzeci kończą się błędem — czyli test łapie dokładnie
  to, co zgłosił właściciel. Do tego 13 sprawdzeń samej reguły odpowiedzi
  (`scratch-odpowiedz.test.mjs`), które na starym kodzie nie przechodzą w pięciu punktach.
**„W OGÓLE NIE WPISUJE ŻADNEGO KONTENERA" — wpisanie jest teraz SPRAWDZANE (wtyczka 1.0.10):**
- **Przyczyna: nikt nigdy nie sprawdzał, czy numer trafił do pola.** Rozszerzenie wysyłało klik
  i tekst przez debuger, po czym BEZ WERYFIKACJI klikało „Sprawdź". Puste pole wygląda wtedy
  dokładnie tak samo jak wypełnione, a terminal na puste zapytanie odpowiada „Brak wyników:" bez
  numeru — czyli objawem błędu było „Baltic Hub nie zna kontenera" albo 60 s czekania na wyniki.
  **Funkcja `stanPola` (wartość w polu, aktywny element, widoczność karty, fokus, czy reCAPTCHA
  wypełniła swoje pole) istniała w `page.js` OD POCZĄTKU i nie była wołana z żadnego miejsca.**
- **Trzy poprawki, każda na inny powód pustego pola:**
  1. **Weryfikacja po każdym podejściu** (`input.js`): po `Input.insertText` czytamy `stanPola`
     i porównujemy z tym, co chcieliśmy wpisać. Nie zgadza się → drugie podejście, tym razem
     z kursorem ustawionym przez `skupPole()` (`focus()` na stronie) zamiast klikiem. Dopiero
     potwierdzona wartość uprawnia do kliknięcia „Sprawdź"; dalej niepusto → wyjątek, czyli stara
     droga awaryjna. Między podejściami pole jest CZYSZCZONE (`czyscPole`) — inaczej `insertText`
     dopisałby numer do resztki i wyszukalibyśmy dwa numery sklejone w jeden.
  2. **`Emulation.setFocusEmulationEnabled`** przy podłączonym debugerze: karta terminala jest
     przypięta i NIEAKTYWNA, więc dla strony jest kartą bez fokusu (`document.hasFocus() === false`),
     a to potrafi wyłączyć obsługę wpisywania. Polecenie każe przeglądarce udawać przed stroną,
     że karta jest na wierzchu — bez zabierania dyspozytorowi tego, na co patrzy.
  3. **Enter „na drugie podejście" tylko przy NIEPUSTYM polu.** Dotąd przy pustym polu naciskaliśmy
     Enter, czyli wyszukiwaliśmy pustkę i sami produkowaliśmy „Brak wyników:". Teraz puste pole
     wypełniamy jeszcze raz drogą z kodu — bez zaufanych zdarzeń, ale zapytanie z numerem bije
     zapytanie puste.
- **Ślad w migawce**: udany przebieg zapisuje przy zleceniu `_sposob` (którą drogą poszło wpisanie)
  i `_w_polu` (co stało w polu), a błąd — dodatkowo `_pole_po_wyslaniu` i powód, dla którego nie
  dało się zmierzyć punktu do kliknięcia. Bez tego „nie zna kontenera" i „zapytanie poszło puste"
  wyglądają w bazie identycznie.
- **Zweryfikowane w prawdziwym Chrome** (`scratch-wpisywanie.test.mjs`, plik tymczasowy), 24
  sprawdzenia w dwóch przebiegach na tej samej maszynerii; atrapa terminala melduje serwerowi
  KAŻDE zapytanie, więc dziennik przeżywa nawigację i widać komplet:
  - **A** — trzy kontenery, wolne wczytywanie, wyniki poprzedniego zostają na ekranie: każde
    zlecenie dostaje odpowiedź o swoim kontenerze, terminal dostaje dokładnie nasze trzy numery
    i ani jednego pustego zapytania, wpisanie idzie drogą zaufaną.
  - **B** — strona liczy WYŁĄCZNIE tekst wpisany zaufanym zdarzeniem (tak zachowuje się formularz
    za reCAPTCHĄ) i ma nad polem przezroczystą warstwę połykającą kliknięcie (na produkcji robiło
    to okno zgody na ciasteczka): rozszerzenie zauważa nietrafiony klik, przechodzi na kursor
    przez `focus()` i **strona przyjmuje tekst jako zaufany** — obie karty odczytane.
  **Test sprawdzony odwrotnie**: na kodzie sprzed poprawki przebieg B wysyła do terminala
  **osiem PUSTYCH zapytań** (`["","","","","","","",""]`) i kończy się dwoma błędami — czyli test
  odtwarza dokładnie to, co zgłosił właściciel.
- **Do zrobienia u właściciela: pobrać wtyczkę 1.0.10 z appki** (guzik „Wtyczka" świeci wtedy
  pomarańczowo) i odświeżyć ją w `chrome://extensions`. Bez tego dalej działa stara.
  Gdyby odczyt nadal się psuł: w `bhub_details` przy zleceniu stoi teraz WPROST, co było w polu —
  to pierwsza rubryka do obejrzenia, zamiast zgadywania.

**TRZY KONTROLE Z KARTY KONTENERA — Time Out, waga celna, wagi ze zlecenia** (właściciel: „sprawdzić
czy Time out jest na pewno pusty (jak nie jest pusty, trójkącik przy numerze kontenera), sprawdzić
czy commodity weight = cargo weight (tak samo trójkącik). Możemy także odczytać masę brutto i netto
w ten sposób (i pogrubić, ona jest zawsze nadrzędna — chyba że w zleceniu jest różnica to poza
pogrubieniem trójkącik)"):
- Odczyt karty (`parse.ts`) bierze teraz `Time Out`, `Cargo Weight [KG]` (= waga TOWARU, u nas
  „Waga netto") i `Commodity Weight [KG]` (waga celna). Brutto (`Weight [KG]` = VGM) czytaliśmy
  wcześniej. **`Time Out` niesie PUSTY TEKST, gdy rubryka jest pusta, i `null`, gdy nie odczytaliśmy**
  — bez tego rozróżnienia nieudany odczyt wyglądałby jak spokojne „kontener stoi".
- Migracja **0031** (ZAAPLIKOWANA przez MCP): kolumny `bhub_time_out`, `bhub_net_weight_kg`,
  `bhub_commodity_weight_kg` + nowe parametry RPC `apply_bhub_check`.
- **ZMIENIONA ZASADA PRZY WADZE BRUTTO, świadomie.** Do tej pory RPC NADPISYWAŁO `loads.gross_weight`
  wagą z terminala. Nie da się jednocześnie nadpisać wartości i pokazać, że się różni — więc terminal
  wpisuje wagi WYŁĄCZNIE W PUSTE POLA (jak wielkość w 0020 i gestia w 0021), a jego własne liczby
  siedzą w `bhub_*`. „Nadrzędność" nie znika: `effectiveGrossWeightKg()` (`src/lib/bhub/checks.ts`)
  daje pierwszeństwo terminalowi i to jego pyta stawka kierowcy oraz kafelek Planu. Przy okazji
  naprawione: `to_char(...)` kasowało też ręczny tekst „według armatora", którego appka w swojej
  regule `canOverwriteGrossWeight` świadomie nie rusza.
- Wygląd: **trójkącik przy NUMERZE KONTENERA** (niepusty Time Out, waga celna ≠ waga towaru) jest
  bursztynowy, nie czerwony — to nie sprzeczność z naszym zleceniem, tylko coś, co mówi terminal.
  Czerwień zostaje dla niezgodności ze zleceniem (wielkość, gestia, teraz też wagi). `CellDecoration`
  ma jawne pole `alarm` zamiast porównywania nazw klas CSS — dzięki temu są dwa poziomy ostrzeżenia.
- **ZALEGŁOŚĆ ZNALEZIONA PRZY OKAZJI: na produkcji stały DWIE wersje `apply_bhub_check`.** Dodanie
  parametru do funkcji Postgresa NIE zastępuje jej, tylko tworzy PRZECIĄŻENIE — więc od 0020 obok
  nowej wisiała stara, 9-argumentowa, a wywołania bez `p_container_size` (ścieżki błędu) pasowały do
  obu. Usunięte; migracja ma teraz DWA `drop`. **Wniosek: po `apply_migration` sprawdzać `pg_proc`,
  a nie poprzestawać na „success".**
- `revoke execute ... from anon, authenticated, public` + **jawny `grant ... to service_role`** —
  samo odebranie PUBLIC odcięłoby funkcję brzegowej, która jako jedyna ją woła.
- **Zweryfikowane, każde na właściwej ścieżce:** odczyt karty — 7 testów Deno (`parse.test.ts`,
  W REPO, nie scratch: treść w kształcie prawdziwej odpowiedzi `/multi`, w tym straż na to, że
  „Cargo/Commodity Weight" nie podszyje się pod brutto). RPC — odpalona NA ŻYWEJ BAZIE w transakcji
  cofniętej wyjątkiem: brutto „według armatora" NIE zostało nadpisane, puste netto uzupełnione,
  `bhub_time_out` wróciło jako pusty tekst (nie null), aktor `bot:baltichub`, a powtórka tego samego
  odczytu NIE dopisała drugiego wpisu do dziennika. Logika appki — 26 sprawdzeń
  (`scratch-kontrole.test.mts`). Przeglądarka (Playwright, tymczasowa strona `/test-kontrole`,
  skasowana po teście) — 22 sprawdzenia na prawdziwej ścieżce REST → `useLoads` → tabela.
- **PUŁAPKA (trzecia z tej rodziny): `toLocaleString("pl-PL")` rozdziela tysiące SPACJĄ NIEŁAMLIWĄ
  (U+00A0)** — porównanie z „24 000" napisanym zwykłą spacją cicho nie przechodzi. Tak samo jak bajty
  NUL w `imap.ts` i ` ` w `readTemplate.ts`.
- **Pułapka testu, nie kodu**: pierwsza wersja testu w przeglądarce zakładała, że `45G1` kłóci się
  z „40HC" — a to ta sama długość (45G1 = 40 stóp high cube). Straż zadziałała poprawnie, złe były
  dane testowe.
- **Funkcja `bhub-status` wdrożona (v38) i ZWERYFIKOWANA MASZYNOWO**: `get_edge_function` zapisuje
  odpowiedź do pliku, więc wdrożone pliki dało się porównać z lokalnymi CO DO ZNAKU zamiast na oko.
  Wyszło 5 z 6 zgodnych, a w `parse.ts` przy przepisywaniu zgubiła się martwa stała
  `NUMER_KONTENERA` (nieużywana — usunięta też z repo, żeby repo i produkcja mówiły to samo).
  **To jest sposób na weryfikację wdrożenia przez MCP: deploy → `get_edge_function` → porównanie
  plików skryptem, nie wzrokiem.**

**TRZY TERMINALE (BHub, BCT, GCT) + alarm MIMO nadpisania** (właściciel: „Wagi, gestie, wielkości
nadpisujemy ale musimy alarmować że się nie pokrywają ze zleceniem!"; „analogicznie dla BCT
sprawdzimy stan kontenera tym samym sposobem […] nasza appka będzie sprawdzać stany na 3
terminalach"):

- **KOREKTA 0031, wprost poproszona.** Tamta migracja rozwiązała napięcie „nadpisać czy pokazać
  różnicę" tak, że przestała nadpisywać. Właściciel chce OBU rzeczy naraz — więc terminal znowu
  nadpisuje, a to, co mówiło zlecenie, ląduje w `loads.terminal_conflicts` (migracja **0032**,
  ZAAPLIKOWANA przez MCP). Wpis powstaje przy PIERWSZEJ rozbieżności, terminal go nie rusza
  (inaczej po kwadransie alarm gasnąłby sam, zanim ktokolwiek by go zobaczył), a kasuje go dopiero
  RĘCZNA poprawka tej kolumny — w tabeli albo w oknie zlecenia. Reguła „nie zapamiętuj własnej,
  starej liczby jako «zlecenia»" ma osobny warunek i osobny test (waga VGM bywa poprawiana).
- Wygląd: te cztery kolumny (brutto, netto, wielkość, gestia) mają teraz jedną wspólną ozdobę —
  pogrubienie, gdy terminal potwierdza, i ⚠ z obiema wartościami w dymku, gdy zlecenie mówiło co
  innego. `effectiveGrossWeightKg()` zostaje, ale po tej zmianie kolumna i tak trzyma wartość
  terminala.

- **BCT i GCT są OSIĄGALNE ZE STRONY SERWERA** (sprawdzone curl-em z tej sesji: BCT to zwykły
  formularz ASP.NET z `__RequestVerificationToken`, GCT — PRADO z `PRADO_PAGESTATE`; oba oddały
  prawdziwe karty). Świadomie NIE korzystamy z tego dziś: właściciel poprosił o „ten sam sposób",
  czyli wtyczkę, a jedna droga dla wszystkich terminali jest prostsza i przenosi się na kolejne,
  które będą się bronić jak Baltic Hub. **To jest jednak realna opcja na przyszłość** — sprawdzanie
  chodziłoby wtedy bez włączonej przeglądarki dyspozytora.
- Parsery napisane na PRAWDZIWYCH odpowiedziach (`supabase/functions/bhub-status/fixtures/`):
  zapytanie poszło naprawdę, a odpowiedź została zrenderowana w prawdziwym Chromium i zapisana jako
  `innerText` — czyli dokładnie w postaci, w jakiej przysyła ją wtyczka. Co się okazało:
  - **BCT to ten sam Navis N4 co Baltic Hub**, ale karta jest TABELĄ: etykieta i wartość w dwóch
    komórkach, więc w tekście nie ma dwukropka (stąd `paryZKarty(karta, false)`).
  - **BCT zapisuje „nic tu nie ma" jako `--`** — bez `pusteJakoPuste` pusta rubryka `Stops`
    wyszłaby jako BLOKADA na kontenerze, czyli „nie wolno zabierać" zamiast „brak blokad".
  - **BCT podaje typ kontenera w starym, LICZBOWYM zapisie ISO („2210")**. `ISO_CODE` i
    `parseIsoType` znają teraz oba warianty; rodzinę z zapisu liczbowego mapujemy TYLKO dla grup
    0x i 1x (uniwersalne) — reszta zostaje „nie wiem", bo zgadnięty open top pojechałby na
    dokumencie przewozowym.
  - **GCT to inny układ**: jedna tabela z polskimi nagłówkami, bez wag i bez armatora. Granicę
    kolumn niesie TABULATOR (sąsiadują „Status" i „Status celny", oba wolnym tekstem ze spacjami),
    więc czytamy tekst PRZED sklejeniem białych znaków. Wartości mają w środku złamania linii,
    dlatego wiersz składamy z PÓL, a nie z linii. „Data/Czas podjęcia" to odpowiednik `Time Out`.
  - GCT nie daje się dopasować do pięciu kodów statusu (własne słownictwo: „na terminalu — w trakcie
    przyjęcia") → status zostaje surowym tekstem bez koloru. **Do wyjaśnienia z właścicielem, jak
    tłumaczyć te stany.**
- Wtyczka **1.1.0**: grupuje zlecenia po terminalach, każdy ma swój adres (do nadpisania w oknie),
  rozmiar paczki (GCT sam zaprasza do pytania zbiorczego — do 10 numerów) i `markerWynikow`.
  Zlecenie z terminalem, którego wtyczka nie zna, dostaje BŁĄD z prośbą o aktualizację, zamiast
  ginąć po cichu.
- **Zweryfikowane**: 15 testów Deno na prawdziwych odpowiedziach BCT i GCT (`parse.test.ts`, w repo
  razem z fixturami), RPC odpalona na ŻYWEJ bazie w transakcji cofniętej wyjątkiem (nadpisuje
  wszystkie cztery kolumny, pamięta wartości zlecenia, przy powtórce ich nie zmienia, przy zmianie
  wagi przez terminal NIE podmienia ich własną starą liczbą, aktor `bot:bct`), 43 sprawdzenia
  logiki appki i 23 w przeglądarce — z podglądem tego, co appka WYSYŁA przy ręcznej poprawce
  (kasuje wpis o tej kolumnie, cudzych nie rusza).
- **Ograniczenie tej sesji**: przeglądarka nie przechodzi przez proxy środowiska (uścisk TLS
  zrywany przez przekaźnik — curl przechodzi), więc fixtury powstały z prawdziwych odpowiedzi HTTP
  wyrenderowanych lokalnie, a nie z sesji na żywej stronie. Nie sprawdzono też, czy heurystyki
  `page.js` (znajdź pole, znajdź guzik) trafiają na żywych stronach BCT i GCT — z HTML-a wynika, że
  tak (`#ContainerNo` + guzik „Sprawdź"; `textarea` + `input[type=submit]` „Pokaż"), ale pierwsze
  uruchomienie u właściciela to potwierdzi.
- **Funkcja `bhub-status` wdrożona (v39) jako PACZKA** (esbuild, `--charset=utf8`): wdrożenie idzie
  przez MCP, czyli treść trzeba przenieść ręcznie, a paczka to połowa objętości źródeł. Źródłem
  prawdy zostają pliki `.ts` w repo; `bundle.js` jest w `.gitignore`.

**PUSTE OKNO WTYCZKI 1.1.0 — niedomknięty napis w `background.js`** (zgłoszenie właściciela: „po
pobraniu nowej wtyczki i zainstalowaniu i kliknięciu jest pusta"):
- **Przyczyna, znaleziona przez sparsowanie pliku jako modułu**: w komunikacie o nieznanym terminalu
  stało `"(guzik „Wtyczka" w appce)."` — zwykły cudzysłów po polskim cytacie ZAMKNĄŁ napis
  wcześniej, więc `background.js` miał BŁĄD SKŁADNI i service worker w ogóle się nie ładował.
  Objaw był mylący: okno wtyczki otwierało się puste (widać sam tytuł), bo `odswiez()` czeka na
  odpowiedź z tła, a nie miał kto odpowiedzieć — obie sekcje okna zostawały ukryte.
- **To ta sama pułapka, która w tej sesji trafiła już dwa razy w pliki testowe** (`"„Brak wyników
  dla: <numer>" = odpowiedź"`). Tam kosztowała minutę, bo test się nie uruchamiał. W kodzie wtyczki
  kosztowała wydanie: **wtyczka nie ma buildu ani bundlera, więc NIC nie sprawdzało składni.**
- **Naprawa trwała, nie punktowa**: `scripts/build-extension-zip.mjs` ma teraz BRAMKĘ — parsuje
  każdy plik `.js` wtyczki jako moduł (`node --check` na kopii `.mjs`) i przerywa pakowanie, gdy
  któryś się nie parsuje. Sprawdzone odwrotnie: celowo zepsuty plik faktycznie blokuje paczkę
  i wypisuje, który to plik i w której linii.
- **Wniosek do zapamiętania: `node --check plik.js` NIE wystarcza** — dla rozszerzenia `.js` Node
  parsuje po swojemu i ten błąd przepuścił. Dopiero kopia z rozszerzeniem `.mjs` (parsowanie jako
  moduł ES) go pokazała.
- Przy okazji, drugie zgłoszenie z tej samej wiadomości („program dalej daje napis status BHub,
  zamiast wszystkie"): napisy w appce i w oknie wtyczki mówią teraz o TERMINALACH, nie o Baltic
  Hubie — kolumna „Status terminala", guzik „Statusy terminali", dymki i komunikaty. Nazwy KOLUMN
  w bazie zostają (`bhub_*`) — siedzą w dzienniku zmian i w zapisanych ustawieniach widoku każdego
  użytkownika, jak przy „Złożone kiedy" i „Ważenie gdzie".
- Wtyczka **1.1.1** — 1.1.0 jest zepsuta i nie wolno jej zostawić u dyspozytorów.

**Odczyt maili wyczerpał środki w Claude Console — naprawione (właściciel: „w nocy program
wykorzystał wszystkie fundusze Claude Console — odczytem zleceń; niech odczyt PDF (płatny) będzie
dopiero po moim kliknięciu"):**
- **Przyczyna, z logów (515 wywołań `parse-order-pdf` przez jedną noc):** `mail-poll` wołał model
  dla KAŻDEGO maila, ZANIM sprawdził, czy mail już jest w bazie — dedup stał dopiero przy zapisie,
  na błędzie `23505`. A kursor Microsoft Graph celowo porównuje `ge` („lepiej powtórzyć wiadomość
  niż ją zgubić"), więc te same maile wracały co 2 minuty i były odczytywane od nowa. **Wniosek na
  przyszłość: w potoku z płatnym krokiem dedup musi stać PRZED kosztem, nie przy zapisie.**
- **Trzy zmiany, każda w innym miejscu:** (1) `mail-poll` sprawdza duplikaty jednym zapytaniem
  przed jakąkolwiek pracą i **w ogóle nie woła modelu** — robi wyłącznie rzeczy darmowe (prefiltr,
  znane szablony); w miejscu usuniętej funkcji stoi komentarz z zakazem jej przywracania.
  (2) Guzik **„Odczytaj przez Claude (płatne)"** w Skrzynce (`src/lib/supabase/readEmailWithClaude.ts`)
  — pobiera załączniki z bucketa, czyta je i ZAPISUJE wynik przy wiadomości, więc drugie otwarcie
  tego samego maila nie kosztuje nic; mail bez załącznika idzie jako tekst (`parseOrderText`).
  (3) `parse-order-pdf` pyta GoTrue, czy za tokenem stoi konkretny użytkownik, i **odrzuca (403)
  wywołania kluczem service_role** — `verify_jwt` sam tego nie łapie, bo service_role to dla niego
  poprawny token. Poprawka w jednym wywołującym nie chroniłaby przed następnym takim automatem.
- Migracja **0022** przywraca harmonogram wyłączony na czas naprawy (`cron.unschedule` ad hoc);
  treść bez zmian wobec 0012. **UWAGA: `execute_sql` przez MCP jest READ-ONLY — `cron.schedule`
  trzeba puszczać przez `apply_migration`.**
- Wdrożone i sprawdzone na produkcji: `parse-order-pdf` v21 (klucz publishable dostaje 403
  `not_a_user`, zero zapytań do modelu), `mail-poll` v15 (wstaje i odpowiada z naszego kodu),
  cron `mail-poll-co-2-min` aktywny.

**AUTO-NAUKA SZABLONÓW — ZROBIONA** (właściciel: „pomyśl jak to zrobić, żeby automatycznie odczyt
zlecenia jednorazowy przez AI był traktowany jako znany szablon, taka auto-nauka"):
- **Skąd bierze się prawda: z pól ZATWIERDZONYCH przez dyspozytora przy zapisie zlecenia, nie z
  odpowiedzi modelu.** Model czyta, człowiek poprawia, a appka dopiero POTEM szuka zapisanych
  wartości w tekście dokumentu i zapamiętuje kotwice „co stoi przed" / „co stoi po" — czyli to samo,
  co ręcznie pisany `q4road.ts` robi przez `between()`.
- **Decyzje właściciela (AskUserQuestion):** (1) uczymy się z pierwszego dokumentu, ale szablon
  wchodzi do gry dopiero, gdy DRUGI dokument tego układu potwierdzi kotwice; (2) zastępuje płatny
  odczyt tylko wtedy, gdy odtworzy KOMPLET kluczowych pól (nr zlecenia, kierunek, kontener, data,
  stawka, spedytor) — inaczej dokument idzie do Claude jak dotąd.
- **Dlaczego dopiero drugi dokument jest w ogóle sensowny technicznie**: z jednego nie da się
  odróżnić etykiety od sąsiedniej wartości. Mając dwa, bierzemy to, co w obu jest STAŁE — reszta
  odpada sama, bez zgadywania.
- Kolejność odczytu: ręczny szablon z kodu → **szablon nauczony** → Claude → ręcznie. Ta sama
  w oknie importu i w `mail-poll`.
- **Dwie rzeczy zmienione przez TESTY NA PRAWDZIWYCH PDF-ach, nie przy pisaniu:**
  1. Wspólna część dwóch dokumentów WCIĄŻ bywa daną (ta sama data, ta sama agencja celna) i wchodziła
     do kotwicy — działało na obu dokumentach, z których się uczyliśmy, i rozsypywało się na trzecim.
     Z kotwic wycinamy więc wszystko, co wygląda na daną (znane wartości, także urwane na brzegu
     okna, oraz daty/kwoty/długie liczby, których appka w ogóle nie zapisuje).
  2. Data i godzina stoją w TABELI, gdzie obok wartości nie ma żadnej etykiety. Reguła może więc
     przeskoczyć zmienną zawartość: kotwiczy na najbliższej stałej etykiecie i bierze n-te
     dopasowanie danego KSZTAŁTU (data, godzina, kwota, kierunek, kontener). Dla pól tekstowych
     jest to zabronione — „n-ty tekst z kawałka" nic nie znaczy.
  Do tego: kwota musi uczyć się jako „3296,00", nie „3296" z kotwicą „,00" (inaczej zlecenie za
  1875,50 przestaje się czytać), a „wspólna końcówka okna" nie sięga etykiety, gdy przed wartością
  stoi INNA wartość — etykiet szukamy osobno w każdym dokumencie i dopiero potem zestawiamy.
- **Straże**: każda reguła musi odtworzyć zatwierdzone wartości w OBU dokumentach co do znaku,
  inaczej nie trafia do szablonu; kotwica trafiająca dwa razy w dokument jest pomijana (pole zostaje
  puste, zamiast wziąć wartość z przypadkowego miejsca); dwie poprawki dyspozytora na polu wyrzucają
  regułę; szablon wyłączony ręcznie NIE wraca sam.
- `supabase/migrations/0023_order_templates.sql` (**ZAAPLIKOWANA przez MCP**): szablony w BAZIE,
  nie w kodzie — nowy spedytor nie wymaga wtedy wdrożenia, a nauka jednej osoby działa od razu
  u wszystkich i w skrzynce. Kształt `rules` zna wyłącznie appka (jak `user_view_settings`).
- Podział plików: `readTemplate.ts` (czytanie — jedzie do Deno przez `build-edge-shared.mjs`)
  i `learn.ts` (uczenie — tylko przeglądarka; serwer ma stosować gotowe reguły, nie wyprowadzać
  nowych). `autoLearn.ts` to czysta decyzja „załóż / potwierdź / doucz / nic", testowalna bez bazy.
  Świadomie BEZ `export *` między nimi — re-eksport gubił się w tsx.
- UI: guzik **„Szablony (N)"** w pasku + `OrderTemplatesDialog` (co appka rozpoznaje, ile razy
  użyła, co poprawiał dyspozytor, „Co czyta" z podglądem kotwic, Wyłącz/Usuń). Po zapisie zlecenia
  w pasku staje zielony komunikat, czego appka się nauczyła — nauka nie dzieje się w ukryciu.
- **Skrzynka też uczy i korzysta**: `readEmailWithClaude` wyciąga tekst załączników przy okazji
  pobrania ich do odczytu, więc zlecenie z maila uczy appkę tak samo jak wgrane ręcznie.
- **Zweryfikowane na PRAWDZIWYCH dokumentach Q4Road** (drugi dokument układu powstawał przez
  podmianę wartości w prawdziwym tekście — tak właśnie różni się kolejne zlecenie): 57 sprawdzeń
  (`scratch-learn.test.mts`, plik tymczasowy) — nauka z pary daje 10 pól ze zlecenia i 15 z listu
  przewozowego, trzeci (niewidziany) dokument czytany ZGODNIE CO DO ZNAKU z ręcznym parserem, obcy
  układ i cudzy NIP odrzucone, pełny cykl życia szablonu z wycofaniem reguły po dwóch poprawkach.
  Przeglądarka (Playwright, prawdziwy PDF): kandydat → aktywny (10 pól) → odczyt kolejnego zlecenia
  bez modelu. **Kluczowy pomiar: tekst tego samego PDF-a z przeglądarki i z Deno jest IDENTYCZNY**
  (6089 znaków, ten sam skrót) — kotwice nauczone u dyspozytora trafiają tak samo po stronie serwera.
- **JEDYNY KROK NIEDOKOŃCZONY: `mail-poll` NIE ZOSTAŁA WDROŻONA** z obsługą nauczonych szablonów
  (kod w repo, `deno check` przechodzi, `shared/readTemplate.ts` wygenerowany). Powód jest
  narzędziowy, nie merytoryczny: `deploy_edge_function` przez MCP wymaga wysłania KOMPLETU 16 plików
  w jednym wywołaniu, a to przekracza limit jednej odpowiedzi. Do zrobienia: `supabase functions
  deploy mail-poll --project-ref itlgexjhznjsbonzdxyg` albo wdrożenie z sesji, w której to jedyne
  zadanie. Do tego czasu appka uczy się i czyta nauczonymi szablonami w PRZEGLĄDARCE, a skrzynka
  zachowuje się jak dotąd (ręczne szablony + guzik „Odczytaj przez Claude").

**ODCZYT TYLKO OZNACZONYCH MAILI — ZROBIONY** (właściciel: „pracownik klienta oznacza zlecenie
czerwonym kolorkiem (taki prostokąt przy widoku załącznika) oznaczając że jest to zlecenie do
wpisania — czy program mógłby tylko odczytywać tak oflagowane zlecenia (pamiętaj żeby nie oznaczać
jako odczytane)"):
- **Czerwony PROSTOKĄT w Outlooku to kolorowa KATEGORIA** (Graph: `categories`), a nie flaga do
  wykonania (Graph: `flag.flagStatus`, rysowana jako chorągiewka). Appka czyta i zapisuje OBA
  sygnały, bo nazwa kategorii jest dowolna — nadaje ją użytkownik skrzynki i z zewnątrz nie da się
  jej znać. Zgadnięcie nazwy znaczyłoby ciche przegapianie zleceń.
- **Reguła jest wąska świadomie**: oznaczenie decyduje o tym, czy mail jest PROPOZYCJĄ NOWEGO
  zlecenia. Mail powiązany z już istniejącym zleceniem (odpowiedź w wątku, numer zlecenia albo
  kontenera w treści) przechodzi BEZ oznaczenia — inaczej zniknąłby wcześniejszy wymóg właściciela
  („nawet jak klient dośle informacje w treści/dodatkowym to program to zobaczy"), bo odpowiedzi
  spedytora nikt w firmie nie oznacza. Osobny test-straż pilnuje tej granicy.
- **Nic nie ginie**: nieoznaczony mail zapisuje się ze statusem `ignored` i powodem, a w Skrzynce
  jest guzik „Pokaż pominięte maile" z ich oznaczeniami. To stamtąd widać, czym te wiadomości są
  NAPRAWDĘ oznaczone, i jednym kliknięciem zawęża się regułę do właściwej kategorii (chipy
  „Kategorie w skrzynce" biorą się z tego, co faktycznie przyszło, nie z listy w kodzie).
- Migracja **0024** (ZAAPLIKOWANA przez MCP): `email_messages.categories`/`flagged` +
  `email_ingest_state.only_marked` (domyślnie **true**, bo o to poprosił właściciel) i
  `marked_categories` (puste = liczy się DOWOLNE oznaczenie).
- **„Nie oznaczać jako odczytane" jest pilnowane na dwóch poziomach i nie zależy od tej zmiany**:
  Graph zmienia stan wiadomości wyłącznie przy jawnym zapisie (`PATCH isRead`), którego appka nigdzie
  nie robi, a ścieżka IMAP otwiera skrzynkę przez `EXAMINE` (tylko odczyt) i pobiera treść przez
  `BODY.PEEK`. Do komendy IMAP doszło `FLAGS` (żeby w ogóle zobaczyć oznaczenia) — jest test-straż,
  że w kodzie nie ma `BODY[]` bez `PEEK` i że `EXAMINE` zostaje.
- **PUŁAPKA ZŁAPANA PRZY OKAZJI: `imap.ts` używa BAJTÓW NUL jako separatora** (`"\0LITERAL\0"`),
  których `cat` nie pokazuje — przy ręcznym przepisywaniu plików do `deploy_edge_function` zamieniły
  się na spacje. Wdrożona kopia jest przez to spójna sama w sobie, ale mniej odporna niż repo
  (sentinel ze spacjami może teoretycznie wystąpić w treści maila). **Wniosek: funkcje brzegowe
  wdrażać `supabase functions deploy` z plików, nie przepisywać ich treścią przez MCP.**
- Zweryfikowane: 17 testów prefiltru (`relevance.test.ts` — nieoznaczony mail z PDF-em odrzucony,
  kategoria i flaga przepuszczone, zawężenie do jednej kategorii bez względu na wielkość liter,
  mail o istniejącym zleceniu przechodzi bez oznaczenia, wyłączona reguła = zachowanie sprzed
  zmiany) + 9 testów klienta IMAP (`imap.test.ts` — flagi parsowane obok literału, brak flag nie
  psuje odczytu, straż na `BODY.PEEK`/`EXAMINE`). `next build` i `deno check` przechodzą; REST widzi
  nowe kolumny, wiersz konfiguracji ma `only_marked = true`.
- **UWAGA: to działa dopiero po wdrożeniu `mail-poll`** (patrz punkt 1 niżej) — cała reguła siedzi
  w funkcji brzegowej.

**Wtyczka do pobrania z appki — ZROBIONE** (właściciel: „guzik, który pozwoli mi zawsze pobrać
aktualną wersję wtyczki"):
- **Paczka powstaje PRZY BUDOWANIU APPKI**, więc nie może rozjechać się z katalogiem `extension/`:
  `scripts/build-extension-zip.mjs` (uruchamiany przez `prebuild`/`predev`, ręcznie `npm run
  wtyczka`) pakuje `extension/` do `public/rozszerzenie/wtyczka.zip` + `wersja.json` (wersja z
  `manifest.json`, rozmiar, data). Katalog `public/rozszerzenie/` jest w `.gitignore` — to artefakt
  buildu, nie kod.
- **ZIP zapisywany własnym kodem** (`zlib` z Node), bez zależności i bez zewnętrznego `zip`:
  paczka musi powstać na komputerze właściciela przed `next build` (appka to eksport statyczny
  wgrywany na Netlify), a `zip` nie istnieje na Windowsie. Wpis, którego deflate wyszedł WIĘKSZY
  niż oryginał (drobne PNG), zapisujemy bez kompresji — inaczej paczka rosłaby.
- W ZIP-ie jest KATALOG `grabowski-statusy-kontenerow/` (Chrome w „Załaduj rozpakowane" wskazuje
  się katalog z `manifest.json`), nazwa stała — aktualizacja to nadpisanie tego samego katalogu
  i „Odśwież" w `chrome://extensions`, bez ponownego logowania. Adres pobrania też jest stały
  (`/rozszerzenie/wtyczka.zip`); wersja idzie w atrybut `download`, więc w Pobranych ląduje
  `grabowski-wtyczka-1.0.8.zip`.
- **Appka wie, czy dyspozytor ma starą wtyczkę**: `bhubExtensionState()` zwraca teraz `wersja`
  (rozszerzenie i tak ją odsyłało w odpowiedzi „stan", nikt tego nie czytał), a `stanPaczki()`
  porównuje ją z paczką — **po członach jako LICZBY**, bo tekstowo „1.0.10" < „1.0.9". Guzik
  „Wtyczka" świeci wtedy na pomarańczowo z kropką, a okno pokazuje kroki AKTUALIZACJI zamiast
  instalacji od zera. Wersja zainstalowana WYŻSZA od paczki (komputer programisty z katalogiem
  wprost z repo) to osobny stan, nie alarm.
- **Po zmianie w `extension/` trzeba podnieść `version` w `manifest.json`** — inaczej appka nie ma
  po czym poznać, że u dyspozytorów siedzi stara wtyczka (napisane też w `extension/README.md`).
- Zweryfikowane: logika + paczka — 20 sprawdzeń (`scratch-wtyczka.test.mts`, plik tymczasowy:
  porównanie wersji, stany paczki, a ZIP rozpakowany **prawdziwym `unzip`**, nie własnym czytnikiem
  — inaczej błąd w formacie byłby niewidoczny, bo ten sam kod pisałby i czytał; PNG bajt w bajt,
  polskie znaki bez zmian, klucz z manifestu na miejscu). Przeglądarka (Playwright, `next dev`,
  tymczasowa strona `/test-wtyczka` z atrapą stanu wtyczki) — 12 sprawdzeń: kliknięcie guzika
  FAKTYCZNIE pobiera plik, pobrany plik jest bajt w bajt tym z `public/`, rozpakowuje się do
  gotowego do wgrania katalogu, a komunikat i instrukcja zmieniają się z wersją (brak / stara /
  aktualna / nowsza). `npm run build` przechodzi i paczka ląduje w `out/rozszerzenie/`.

**`mail-poll` WDROŻONA (v16) — i przy okazji okazało się, że SKRZYNKA JUŻ DZIAŁA:**
- **To koryguje wcześniejszy zapis „nie ma jeszcze danych dostępowych do Exchange'a".** Sekrety
  Microsoftu są wpisane, cron chodzi co 2 minuty, a w bazie leży 892 przejrzanych wiadomości,
  398 zapisanych, 94 propozycje w Skrzynce, 1 zlecenie przyjęte, 2 odrzucone. Odczyty, które
  do tej pory były (`parse_source`), pochodzą WYŁĄCZNIE z guzika „Odczytaj przez Claude" — bo
  wdrożona wersja nie znała ani nauczonych szablonów, ani nowych reguł.
- **Wdrożone jako BUNDLE, nie jako 16 plików.** Powód jest narzędziowy: `deploy_edge_function`
  przez MCP wymaga wklejenia treści WSZYSTKICH plików w jednym wywołaniu (~104 kB), a to nie mieści
  się w limicie jednej odpowiedzi. Bundle (45 kB) mieści się z zapasem. Polecenie, którym powstał:

      supabase/functions/mail-poll$ esbuild index.ts --bundle --format=esm --platform=neutral \
        --target=esnext --charset=utf8 --external:'npm:*' --external:'jsr:*' --external:'node:*' \
        --outfile=bundle.js

  `--charset=utf8` jest OBOWIĄZKOWE: bez niego esbuild zamienia polskie znaki na `\uXXXX` i plik
  puchnie czterokrotnie (dokładnie ta pułapka, która wysadziła poprzednią próbę wdrożenia).
  `--packages=external` w `deno bundle` NIE działa — Deno i tak wchodzi w `node_modules` pdfjs-a
  i wykłada się na opcjonalnej zależności `canvas`.
- **Źródłem prawdy zostaje `supabase/functions/mail-poll/` w repo**; wdrożony plik ma na górze
  komentarz, że jest artefaktem budowania. **Droga PREFEROWANA to nadal `supabase functions deploy
  mail-poll --project-ref itlgexjhznjsbonzdxyg`** (wgrywa prawdziwe pliki, czytelne w Dashboardzie)
  — ta sesja nie miała tokenu dostępowego Supabase, tylko MCP.
- **Pułapka MCP: przy funkcji, która miała import mapę, trzeba PODAĆ `import_map_path` i dołączyć
  `deno.json`** — inaczej deploy odbija się błędem „import map path does not exist" ze sklejoną
  ścieżką z POPRZEDNIEJ wersji.
- **Bajty NUL w `imap.ts` zamienione na sekwencję ucieczki** (`LITERAL_SEP`, commit efc6716):
  nie widać ich w podglądzie, gubią się przy przenoszeniu treści (przy poprzednim wdrożeniu
  zamieniły się na spacje), a git traktował przez nie plik jako binarny.
- Sprawdzone po wdrożeniu: strzał kluczem publishable → 401 „Brak uprawnień do uruchomienia odczytu
  skrzynki", zła metoda → 405 (czyli funkcja wstała i chodzi po naszym kodzie, z polskimi znakami
  bez uszczerbku); `deno check` i 26 testów Deno przechodzi przed wdrożeniem.
- **UWAGA — reguła „czytaj tylko oznaczone" WCHODZI W ŻYCIE DOPIERO TERAZ** (`only_marked = true`,
  `marked_categories` puste = liczy się dowolne oznaczenie). Od tego wdrożenia mail z PDF-em staje
  się propozycją nowego zlecenia TYLKO, gdy ma kategorię albo flagę; mail dotyczący ISTNIEJĄCEGO
  zlecenia przechodzi jak dotąd. **Nie wnioskować z istniejących wierszy, że nikt nie oznacza** —
  mają puste `categories`/`flagged`, bo poprzednia wersja tych kolumn w ogóle nie zapisywała.
  Pierwszy przebieg po wdrożeniu pokaże realne oznaczenia; widać je w Skrzynce pod „Pokaż pominięte
  maile".
- **Nauczonych szablonów jest na razie ZERO** (`order_templates` puste) — auto-nauka czeka na
  pierwsze zlecenia zapisane przez appkę od czasu jej wdrożenia. Do tego czasu poller czyta za
  darmo tylko dokumenty Q4Road (szablon z kodu), reszta czeka na guzik „Odczytaj przez Claude".

**„PLAN WSPANIAŁY" — DRUGI WIDOK NA TE SAME ZLECENIA** (właściciel: „dodamy oprócz głównego widoku
zestawienie widok plan wspaniały; jedno wynika z drugiego, więc zmiany w jednym wpływają
automatycznie na drugie"; służy do planowania tras kierowców i umiejscowienia kontenerów na
pojazdach):
- **Kształt wprost z opisu właściciela**: pięć kolumn — (1) pojazd + kierowca, a pod nimi ładowność;
  (2,3) EKSPORT z danego dnia roboczego, najpierw tył naczepy/przyczepa, potem przód
  naczepy/solówka; (4,5) IMPORT z NASTĘPNEGO dnia roboczego, analogicznie. W eksporcie kafelek ma
  dolną linię „po jakim imporcie jest kontener"; **w imporcie tej linii NIE MA** — właściciel:
  „import jest prosty, tam są tylko realne ładunki z informacjami o nich".
- **Okno czterech dni roboczych: −1 / dzień planu / +1 / +2** (właściciel po pierwszym obejrzeniu:
  „chciałbym, żeby widok pokazywał się −1 +2 […] resztę sobie będziemy zaciągać z archiwum, zależy
  nam na wygodnej pracy"). Każdy dzień to ten sam blok co wcześniej — EKSPORT tego dnia + IMPORT
  następnego dnia roboczego — więc bloki NIE dublują tej samej pary (kierunek, data); jest na to
  osobny test. Liczone w dniach ROBOCZYCH: w poniedziałek „−1" to piątek, a „+2" z czwartku to
  poniedziałek. Strzałki i pole daty przesuwają całe okno; szerokość okna to dwie stałe
  (`PLAN_DAYS_BEFORE`/`PLAN_DAYS_AFTER`) w `planBoard.ts`.
  Skutki, o których łatwo zapomnieć przy zmianie szerokości okna: lista „Do zaplanowania" obejmuje
  CAŁE okno (przy każdym zleceniu stoi jego dzień), a nieobecność auta jest liczona per dzień —
  wiersz pokazuje urlop tylko w tych dniach, w których auto faktycznie nie jeździ.
- **Dni idą JEDEN POD DRUGIM, nie w bok** (właściciel po zobaczeniu pierwszej wersji: „przewijanie
  jest w tej chwili lewo-prawo dni, a ma być góra-dół"). Pierwsza wersja rozkładała okno poziomo
  (4 dni × 4 kolumny = 16 kolumn) — teraz kolumny są CZTERY i stałe, a każdy dzień to sekcja
  z własnym nagłówkiem, pod którym stoją wszystkie auta. Stąd `PlanRow.blocks[]` (ten sam pojazd
  w kolejnych dniach) zamiast kolejnych kolumn w wierszu; wiersz pojazdu powtarza się w każdej
  sekcji, więc selektory w testach muszą podawać `data-dzien`. Jest test-straż na sam układ:
  cztery nagłówki slotów, zero nagłówków dnia w `<thead>`, każda kolejna sekcja niżej od
  poprzedniej i w tej samej kolumnie.
- **Daty stoją NAD swoimi kolumnami, nie w jednym pasku** (właściciel: „miał być eksport załóżmy
  03.09, import 04.09 i to mieliśmy przewijać góra-dół, czyli wyżej zobaczę 02.09 > 03.09"). Nagłówek
  sekcji to trzy komórki: „dzień planu / dzień wstecz / +N dzień" nad kolumną pojazdu, **EKSPORT
  <data>** nad kolumnami eksportu i **IMPORT <data następnego dnia roboczego>** nad kolumnami
  importu. W `<thead>` tych dat być NIE MOŻE — kolumny są wspólne dla wszystkich sekcji; pierwsza
  wersja pionowa trzymała obie daty w jednym pasku na całą szerokość i para „eksport → import"
  przestała być widoczna nad właściwymi kolumnami. Test sprawdza teraz same PARY dat sekcji
  (02.09→03.09, 03.09→04.09, 04.09→07.09, 07.09→08.09), czyli dokładnie to, co opisał właściciel.
- Przy czterech dniach × kilkudziesięciu autach lista robi się długa, więc doszły dwa sposoby jej
  skrócenia: przełącznik **„tylko auta z ładunkiem"** w pasku (domyślnie WYŁĄCZONY — właściciel
  prosił o „wszystkie auta", bo z pustych wierszy widać wolne moce) i **„Ukryj to auto w planie"**
  w ustawieniach wiersza (ukryte auto i tak wraca w dniu, w którym coś na nim stoi).
- **Bez własnego zbioru danych.** Plan czyta `loads` i tylko inaczej je układa: wiersz z
  `vehicle_plate`, kolumna z `direction` + `load_date`, a jedyne, czego brakowało, to MIEJSCE na
  zestawie. Stąd `loads.plan_slot` (`tyl`/`przod`) i `loads.plan_prev_note` (ręczne nadpisanie
  pamiątki) — migracja **0025** (ZAAPLIKOWANA przez MCP + `notify pgrst`), a nie osobna tabela
  przypisań: dwie kopie tej samej prawdy rozjechałyby się przy pierwszej edycji w Zestawieniu.
  Obie kolumny są też w Zestawieniu („Miejsce (plan)" listą, bo w bazie stoi CHECK; „Po jakim
  imporcie" w bloku Inne), więc plan da się poprawić z obu stron.
- **40/45 nie dostało trzeciej wartości `plan_slot`** — o zajęciu całego zestawu decyduje
  `container_size`, czyli ta sama dana, którą widzi Zestawienie; kafelek scala wtedy obie kolumny
  wiersza (`colSpan=2`), a zapis idzie zawsze jako `tyl`. Reguła (a) właściciela pilnowana osobno:
  **40/45 na solówkę = odmowa z komunikatem**, nie cichy zapis. **Nieznana wielkość NIE blokuje
  drugiego miejsca** (w danych klienta puste „Wielkość" jest częste — blokada odbierałaby pół
  zestawu przy każdym niedoczytanym dokumencie).
- **Kontener z importu dnia X sam pokazuje się w EKSPORCIE dnia X** (właściciel: „kontenery będące
  dnia X w imporcie będą szły automatycznie do exportu tego samego dnia — ale zostawiamy tylko
  informacje o miejscowości, gestii i nr kontenera; ładunki na export (export/krajówka/zjazd na
  pusto) będziemy właśnie w eksporcie dodawać"). To NIE jest zlecenie, tylko podpowiedź na wolnym
  miejscu (`PlanCell.carriedFrom`, przerywana ramka, nagłówek „z importu") — miejsce dalej przyjmuje
  upuszczenie i klik, a po dołożeniu eksportu podpowiedź znika, bo relację niesie wtedy linia „po:".
  Trzy szczegóły, które łatwo przeoczyć: miejsce (tył/przód) przenosi się jeden do jednego; pusta
  czterdziestka zajmuje cały zestaw tak samo jak pełna, ale **nie scalamy kolumn, gdy obok stoi już
  prawdziwe zlecenie** (podpowiedź nie może schować cudzej pracy); i podpowiedź liczy się z CAŁEGO
  `loads`, nie z okna — import z pierwszego dnia okna należy do sekcji, której już nie widać, więc
  bez tego pierwsza sekcja byłaby ślepa.
- **„Na pusto do:" na podpowiedzi z importu** (właściciel: „jeżeli składamy na pusto, dodaj
  możliwość wyboru gdzie składamy — jeżeli jest nie zaplanowany"). Lista `EMPTY_DROP_LOCATIONS`
  (GCT / BCT / BHub / Depot — bez „Poimport", bo to pochodzenie kontenera, nie miejsce zdania)
  zapisuje `submitted_where` NA TYM IMPORCIE, czyli tę samą kolumnę co „Złożenie gdzie"
  w Zestawieniu — wybór widać po obu stronach i wchodzi do dziennika zmian. Wartość spoza listy
  (np. „zgodnie z instrukcjami armatora") zostaje jako dodatkowa opcja. Pole znika, gdy na kontener
  dołożono ładunek — wtedy nie jedzie na pusto. `stopPropagation` na `<select>` jest konieczne:
  komórka pod spodem jest celem kliknięcia przy wstawianiu zlecenia.
- **Kafelek IMPORTU niesie komplet** (właściciel: „dodaj wagę brutto przy imporcie, odprawa,
  adr/sent, spedycja zlecająca"): `gross_weight` (czysta liczba formatowana na „24 500 kg", tekst
  typu „według armatora" zostaje dosłownie), `customs_status`, `adr_flag` jako czerwona plakietka
  i `forwarder`. **Eksport zostaje zwięzły** — te cztery pola są tylko po stronie importu, na to
  jest test-straż. Kolumna `adr_flag` w Zestawieniu ma teraz etykietę „ADR/SENT" (to jedno pole na
  oba oznaczenia, wartość wpisuje dyspozytor).
- **Nic nie ginie**: kontener wypchnięty przez czterdziestkę i „trzeci na zestawie" lądują w
  czerwonym pasku „Nie mieści się na zestawie" przy kafelku; pojazd z tablicy, której nie ma w
  Panelu floty, dostaje własny wiersz („spoza Panelu floty"); **zlecenie BEZ DATY** trafia do
  bocznej listy z plakietką „bez daty", a położenie go na miejscu USTAWIA datę tej kolumny.
- Wstawianie **przeciąganiem I klikiem** (właściciel wybrał oba): przeciągnij z listy „Do
  zaplanowania" albo kliknij zlecenie i kliknij wolne miejsce. Upuszczenie zapisuje pojazd, naczepę
  z Panelu floty, kierowcę etatowego wiersza i jego nr dowodu — ale **pustym ustawieniem wiersza nie
  kasujemy kierowcy odczytanego z dokumentu**. „×" na kafelku zdejmuje zlecenie z planu.
- **Pamiątka „po:" wyliczana + do nadpisania ręcznie** (wybór właściciela): najpóźniejszy import
  tego pojazdu z datą nie późniejszą niż eksport (ten sam slot ma pierwszeństwo), nigdy z
  przyszłości. Klik w linię otwiera okno; wpisany tekst siada w `plan_prev_note` i wygrywa.
- **Wiersze to WSZYSTKIE auta z Panelu floty** (ciągniki i solówki; na produkcji 40 ciągników, 0
  solówek, 43 naczepy) plus „opcja wpisania urlopu połączona z panelem floty". Urlopy kierowców SĄ
  w Panelu floty (`drivers[].vacations` = `[{startDate,endDate}]`) i appka je czyta, **nigdy tam nie
  pisząc**; własna tabela `plan_absences` obok dokłada nieobecność samego auta (awaria, serwis).
  Druga tabela, `plan_vehicles`, trzyma to, czego Panel floty NIE MA: **kierowcę etatowego** (rekord
  pojazdu we flocie nie wiąże kierowcy — sprawdzone) i **ładowność** (właściciel zapowiedział
  dodanie pola we flocie; `fleetStore` czyta już kilka możliwych nazw i weźmie wartość stamtąd, gdy
  się pojawi, a wpis w planie zostaje nadpisaniem) plus kolejność wierszy i ukrycie auta.
- **PUŁAPKA złapana zapytaniem, nie samym „success": `revoke execute ... from anon, authenticated`
  NIE odbiera prawa do funkcji** — Postgres nadaje EXECUTE roli PUBLIC z automatu, więc funkcja
  triggerowa dalej stała w API jako `/rest/v1/rpc/`. Trzeba `from anon, authenticated, public` (to
  samo, co 0006). Sprawdzone `has_function_privilege` po zaaplikowaniu.
- Zakładki „Zestawienie / Plan wspaniały" (`src/components/AppViews.tsx`). Synchronizacji nie ma i
  nie trzeba: oba widoki czytają ten sam cache TanStack Query odświeżany przez Realtime.
- **Zweryfikowane**: logika — 50 sprawdzeń (`scratch-plan.test.mts`, plik tymczasowy; jedno złapało
  realny błąd: kontener wypchnięty przez czterdziestkę liczył się dwa razy). Przeglądarka
  (Playwright, `next dev`, tymczasowe strony `/test-plan` i `/test-widoki`, usunięte po teście) —
  31 + 6 sprawdzeń **z podstawionym REST-em, nie z atrapą hooków**, więc szła ta sama ścieżka co w
  appce (fetch → TanStack Query → widok → PATCH): cztery dni okna z właściwymi datami i kolumnami,
  zlecenia z dnia −1 i +2 w swoich blokach, scalenie kolumn przy 40HC, brak drugiego miejsca,
  pamiątka wyliczona i nadpisana, odmowa 40HC na solówkę BEZ zapisu, 20DV na solówce zapisane,
  prawdziwe przeciąganie, zdjęcie z planu, upsert ładowności, przełączanie zakładek bez błędu
  strony. Baza — REST widzi nowe tabele i kolumny (brak PGRST204), insert bez sesji odbity przez
  RLS (42501), `loads` przez klucz publishable wraca puste mimo 6 wierszy (RLS działa).
  **UWAGA przy uruchamianiu Playwrighta w tym środowisku**: wersja z `node_modules` szuka
  chromium-1234, a zainstalowany jest 1194 — `chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })`.
  **NIE zweryfikowane na żywym koncie** — pierwsze planowanie u właściciela pokaże resztę
  (środowisko sesji nie ma konta do zalogowania).
- **Do dopytania właściciela przy pierwszym użyciu**: w arkuszu przy miejscowości stoi liczba
  („2 Łódź", „1 Warszawa") — nie wiadomo, co znaczy, więc kafelek jej nie pokazuje. Do tego dobór
  pól na kafelku (dziś: wielkość, miejscowość + firma, nr kontenera · wielkość · gestia, podjęcie ·
  godzina · nr zlecenia) jest propozycją, nie ustaleniem.

**PODGLĄD ŹRÓDŁA przy poprawianiu pól — ZROBIONY** (właściciel: „odczytując zlecenia z maila nie
widzę źródła — więc nie jestem w stanie skorygować błędów"):
- `src/components/zestawienie/SourcePreview.tsx` — panel OBOK formularza (nie osobne okno: dokument
  i pola muszą być widoczne JEDNOCZEŚNIE, inaczej poprawianie sprowadza się do przepisywania
  z pamięci). Zakładki: treść maila + każdy dokument; PDF w ramce, do tego „Otwórz w nowej karcie"
  (ramka bywa za mała, a część przeglądarek ma wyłączony wbudowany czytnik PDF).
- Jedno źródło URL-a na dwa pochodzenia pliku: wybrany w oknie (`URL.createObjectURL`, zwalniany
  przy przełączeniu — inaczej każda zmiana zakładki zostawiałaby w pamięci kopię PDF-a) i leżący
  w Storage (`signedStorageUrl`, `src/lib/supabase/storageUrl.ts` — oba buckety są PRYWATNE, więc
  bez podpisu nie pokaże się nic; `signedDocumentUrl` korzysta teraz z tego samego helpera).
- Skąd biorą się źródła: **Skrzynka** (treść maila + załączniki z bucketa `order-emails`),
  **import** (każdy wybrany plik, także nieodczytany — to z niego dyspozytor przepisze pola) oraz
  **„Dopnij PDF"** przy wierszu (dokumenty już zapisane przy zleceniu, `load-documents`).
- W samej Skrzynce doszedł guzik **„Treść maila"** — podgląd bez sieci i bez kosztu, do oceny
  „czy to w ogóle zlecenie", ZANIM ktoś kliknie płatny odczyt przez Claude.
- Okno zlecenia rozszerza się do `max-w-[92rem]`, gdy źródło jest otwarte; da się je schować
  („Ukryj źródło"). Panel jest ukryty poniżej `lg` — na wąskim ekranie nie ma go gdzie postawić.

**KRAJÓWKA — trzeci typ zlecenia** (właściciel: „musimy dodać trzeci typ zlecenia — krajówka,
zaliczamy do exportów ale są one zawsze nadrzędne (nad nimi) w zestawieniu, w planie wspaniałym też
to będzie podpięte pod export"):
- Migracja **0026** (ZAAPLIKOWANA przez MCP, CHECK sprawdzony zapytaniem): `direction in ('I','E','K')`.
  Trzecia WARTOŚĆ, nie flaga przy eksporcie — w Zestawieniu krajówka ma własny blok, który STOI NAD
  eksportem, a grupowanie idzie po `direction`.
- **Cała wiedza o kierunkach w jednym pliku**: `src/lib/loads/direction.ts` — kolejność bloków
  (`K` → `E` → `I`), etykiety, skróty (KRAJ/EKS/IMP), opcje list i **`isExportSide()`**. Reguła
  „krajówka zachowuje się jak eksport" (kolumny Planu, etykiety „załadunek", trasa na fakturze)
  siedzi WYŁĄCZNIE tam: rozsypana po kilkunastu `=== "E"` pierwszym przeoczeniem wysłałaby krajówkę
  do kolumn importu. **Nie porównywać `direction === "E"` poza tym plikiem** (wyjątki są dwa i oba
  są opisane w kodzie: strona kolumny w Planie i wybór „Poimport / z Depotu" na fakturze).
- Zestawienie: nowa kolumna **„Kierunek"** (lista I/E/K, w komórce nazwa, nie kod) — bez niej nie
  dałoby się przestawić zlecenia na krajówkę bez ponownego importu, bo kierunek był tylko nagłówkiem
  bloku. Wyszukiwarka zna słowo „krajówka" (kod `K` sam w sobie nic nie mówi).
- Plan wspaniały: krajówka wchodzi w kolumny EKSPORTU tego samego dnia, kolumna importu ją odrzuca
  (`assignRefusal` porównuje STRONĘ, nie literę). Kafelek i boczna lista mają fioletową plakietkę
  KRAJ — bez niej wyglądałaby jak zwykły eksport, a to inna robota.
- Faktura: krajówka nie ma portu po żadnej stronie, więc trasa to same miejscowości, a zlecenie bez
  kontenera nazywa się „Transport krajowy…", nie „Transport kontenera ?".
- `parse-order-pdf` **wdrożona (v22)**: enum kierunku ma `K`, a zasada 3 promptu mówi wprost, że
  „oba adresy w Polsce" NIE wystarcza (przewóz kontenera z portu do magazynu też jest krajowy, a to
  import). Nauczone szablony też umieją krajówkę (`parseOne`, warianty zapisu w `learn.ts`).

**WIĘCEJ NIŻ JEDNO MIEJSCE ZAŁADUNKU/ROZŁADUNKU** (właściciel: „zlecenia krajowe, bądź w sumie
jakiekolwiek, mogą mieć więcej niż jeden rozładunek/załadunek"):
- Migracja **0027** (ZAAPLIKOWANA + `notify pgrst`): `loads.stops jsonb not null default '[]'`
  z CHECK-iem „to ma być lista". Trzyma miejsca **DRUGIE I DALSZE** — pierwsze zostaje w kolumnach
  z 0001 (`company_name`/`address`/`city`/`secondary_date`/`time_of_day`), bo czyta je cała reszta
  appki; przepisanie go do listy dałoby dwie kopie tej samej prawdy. Kształt elementu zna wyłącznie
  appka (`src/types/loadStop.ts`), stąd `normalizeStops()` na KAŻDYM odczycie.
- Bez osobnej tabeli `load_stops`: miejsca czyta się i zapisuje zawsze razem ze zleceniem (jeden
  UPDATE, jeden wpis w dzienniku), więc tabela dokładałaby join, RLS i kanał Realtime, nie
  obsługując żadnego zapytania, którego dziś nie da się zrobić.
- UI: `StopsEditor` (ten sam komponent w oknie importu i w oknie przy wierszu), kolumna **„Kolejne
  miejsca"** ze skrótem („Warszawa; Radom"). **Kliknięcie tej komórki otwiera OKNO, nie edytor
  inline** — edytor zapisuje tekst, więc Enter skasowałby całą listę. Kafelek Planu pokazuje
  „+ N kolejnych miejsc" (od liczby miejsc zależy, czy auto zdąży tego dnia z czymkolwiek innym),
  a trasa na fakturze wymienia wszystkie miejscowości.
- `ParsedOrder.extra_stops` scala się jak reszta pól — **`isEmpty` musiał nauczyć się tablic**: bez
  tego pusta lista uchodziłaby za wartość i drugi dokument nigdy nie dołożyłby miejsc.
  `loadSearchText` rozkłada listę na wartości (inaczej `String()` dałby „[object Object]", czyli
  miasto drugiego rozładunku byłoby NIE DO WYSZUKANIA).
- `parse-order-pdf` (v22): schemat ma `extra_stops`, a zasada 6 promptu — dotąd „wybierz PIERWSZE
  miejsce, resztę doda dyspozytor" — mówi teraz, jak rozłożyć miejsca na pola i listę.

**Zweryfikowane w tej sesji:** logika — 23 sprawdzenia (`scratch-krajowka.test.mts`, plik
tymczasowy: kolejność bloków, `isExportSide`, odczyt „krajówka"/„K", plan i odmowy, trasy faktur,
normalizacja i scalanie miejsc, wyszukiwarka). Przeglądarka (Playwright, `next dev`, tymczasowa
strona `/test-krajowka`, skasowana po teście) — 15 sprawdzeń: bloki dnia w kolejności Krajówka →
Eksport → Import, kolumna „Kierunek" z nazwą, skrót miejsc w komórce, klik otwierający OKNO (a nie
edytor inline), dodanie/usunięcie miejsca, panel Źródło z zakładkami, treść maila i PDF w ramce
(`blob:`), dokument i pola widoczne obok siebie, chowanie i przywracanie źródła. Baza — insert
zlecenia `K` z dwoma miejscami NA ŻYWEJ bazie w transakcji cofniętej wyjątkiem: CHECK przeszedł,
dziennik zapisał diff `stops` i nie został po tym ani jeden wiersz. Do tego `next build`, `deno
check` i 26 testów Deno.
**NIE zweryfikowane na żywym koncie** (środowisko sesji nie ma konta): zapis krajówki i miejsc
z przeglądarki oraz podgląd załącznika maila podpisanym URL-em.
**`mail-poll` NIE zostało przewdrożone** — wdrożona wersja (v16) nie zna ani `K`, ani `extra_stops`,
więc propozycje ze skrzynki przychodzą bez nich (dyspozytor ustawia je w formularzu; nic się nie
gubi). `supabase/functions/mail-poll/shared/` jest już przegenerowane, więc wystarczy
`supabase functions deploy mail-poll --project-ref itlgexjhznjsbonzdxyg` — przez MCP trzeba by
wklejać cały bundle, a maszynowo wygenerowanego pliku nie przepisuje się ręcznie.

**KILKA ZAŁĄCZNIKÓW = CZASEM KILKA ZLECEŃ + brakujące pola (zgłoszenia właściciela: „czasami mail
nie ma załączników, a czasami jest ich kilka (kilka zleceń)"; „nie widzę opcji wpisania daty
złożenia (cut off) oraz zaznaczenia SENT bądź ADR"; „brakuje pola nr telefonu odbiorcy"):**
- **Największa pułapka: dotąd WSZYSTKIE wgrane naraz dokumenty appka scalała w JEDNO zlecenie** (bo
  u Q4Road jedno zlecenie = zlecenie spedycyjne + list przewozowy). Przy mailu z dwoma zleceniami
  scalenie „tylko puste pola" zlepiłoby dwa ładunki w jeden rekord — z numerem i stawką pierwszego,
  a drugie zniknęłoby bez śladu. `src/lib/loads/documentGroups.ts` rozdziela dokumenty po NUMERZE
  ZLECENIA (tym samym kryterium, co rozpoznawanie zleceń już zapisanych: forma znormalizowana +
  klucz z posortowanych członów, więc „KPB / 87" == „87 / KPB").
- Dokument BEZ numeru (list przewozowy, nieodczytany skan) dołącza do JEDYNEJ grupy — to przypadek
  Q4Road. Gdy grup jest kilka, appka **nie zgaduje**: robi osobną pozycję i mówi o tym wprost.
  Zgadnięcie znaczyłoby dopięcie dokumentu do cudzego zlecenia, czego z Zestawienia już nie widać.
- `ImportOrderDialog` ma teraz KOLEJKĘ zleceń: pasek „Zlecenie 2 z 3", zapis otwiera następne
  (okno nie zamyka się po pierwszym), jest „Pomiń to zlecenie". Każde zlecenie ma własne dokumenty
  — `onSaved(loadId, externalIds)` mówi Skrzynce, KTÓRE załączniki maila podpiąć do tego zlecenia
  (dopięcie wszystkich do każdego byłoby bałaganem nie do odkręcenia).
- Mail bez załączników działa jak dotąd (jedno zlecenie z treści); załączniki bez własnego odczytu
  (starszy `mail-poll`, skan) też — `ordersFromAttachments` opisuje wszystkie trzy przypadki.
  Płatny odczyt zapisuje teraz pola PER ZAŁĄCZNIK (`email_attachments.parsed`) — bez tego nie da
  się rozdzielić maila na zlecenia.
- **Cut off był w formularzu, ale przy „Nr plomby"** — właściciel go tam nie znalazł. Przeniesiony
  do dat („Data złożenia — cut off", obok daty i godziny rozładunku).
- **ADR / SENT**: dwa checkboxy (`src/lib/loads/adrSent.ts` → jedna kolumna tekstowa `adr_flag`).
  Reguła: dopisek z dokumentu („ADR kl. 3") NIE ginie przy przełączaniu — checkboxy przestawiają
  tylko słowa ADR/SENT, reszta zostaje.
- **Telefon odbiorcy** (`contact_phone`, kolumna była w bazie od 0001, ale nie było jej w
  formularzu) — pole obok adresu; w schemacie funkcji opisane wprost jako NIE telefon kierowcy.
- `parse-order-pdf` **wdrożona (v23)**: schemat ma `adr_sent` i `contact_phone`.
- **`mail-poll` WDROŻONA (v18) — potwierdzone na żywej skrzynce**: przebieg crona po wdrożeniu
  zakończył się bez błędu, `seen_total` 1098 → 1105, `last_error` puste. Zna teraz krajówkę,
  kolejne miejsca, ADR/SENT i telefon odbiorcy.
- **PUŁAPKA WDROŻENIA, złapana od razu: `deploy_edge_function` przez MCP ma `verify_jwt` DOMYŚLNIE
  `true`.** Pominięcie tego pola przy `mail-poll` (która MUSI mieć `false`, bo cron woła ją bez
  JWT — tylko z nagłówkiem `x-ingest-secret`) odcięło odczyt skrzynki na kilka minut. Przy KAŻDYM
  wdrożeniu tej funkcji podawać `verify_jwt: false` wprost.
- Druga rzecz do zapamiętania: **`Deno.readTextFile(import.meta.url)` NIE działa w Edge Functions**
  (runtime nie ma źródła na dysku — „path not found: /var/tmp/sb-compile-edge-runtime/source/…"),
  więc pomysł „funkcja poda odcisk SHA-256 własnego pliku" jako weryfikacja bundla przeniesionego
  przez MCP odpada. Zostaje weryfikacja po zachowaniu: strzał curl-em (czy odpowiada NASZYM
  komunikatem) + stan `email_ingest_state` po najbliższym przebiegu crona.
- Przy okazji: z plików wspólnych zniknęły NIEWIDOCZNE znaki — `\u00A0` w regexach `readTemplate.ts`
  i typograficzny apostrof w `tare.ts` zapisane jako sekwencje ucieczki. Przy przenoszeniu treści
  przez MCP takie znaki gubią się bezszelestnie (tak jak wcześniej bajty NUL w `imap.ts`).
- **Zweryfikowane**: logika — 16 sprawdzeń (`scratch-grupy.test.mts`, plik tymczasowy: rozdzielanie
  dokumentów, dokument bez numeru przy kilku zleceniach, mail bez załączników, nieodczytany skan,
  ADR/SENT z dopiskiem). Przeglądarka (Playwright, tymczasowa strona `/test-kolejka`, skasowana po
  teście) — 12 sprawdzeń: pasek „1 z 2", pola pierwszego zlecenia, cut off przy datach, ADR+SENT
  bez gubienia „kl. 3", telefon odbiorcy, „Pomiń" wczytuje DRUGIE zlecenie (Radom), pola nie
  przeciekają między zleceniami, etykiety załadunku przy eksporcie, źródło towarzyszy kolejnemu
  zleceniu. Do tego `next build`, `deno check`, 26 testów Deno i strzały w obie wdrożone funkcje.

**REGRESJA: przestała się uzupełniać domyślna „Data" — naprawiona u źródła** (zgłoszenie
właściciela: „z jakiegoś powodu przestałeś automatycznie uzupełniać datę (domyślnie dzień roboczy
przed rozładunkiem)"):
- **Przyczyna, dokładnie**: `mail-poll` dolicza domyślną datę tylko do pól SCALONYCH przy mailu
  (`email_messages.parsed`), a przy KAŻDYM ZAŁĄCZNIKU zapisuje surowy odczyt szablonu. Od kiedy okno
  bierze pola per załącznik (żeby rozdzielić kilka zleceń z jednego maila), data z tamtego scalenia
  w ogóle nie dochodziła — i pole „Data" zostawało puste.
- **Wniosek szerszy niż ta jedna data**: reguła „appka to sobie dolicza" nie może siedzieć w JEDNEJ
  z dróg odczytu, bo dołożenie drugiej drogi cicho ją gubi. Wszystkie trzy takie reguły (domyślna
  data, brutto = towar + tara, gestia „Leasing" z uwag) siedzą teraz w `src/lib/loads/prepareOrder.ts`
  i przechodzi przez nie KAŻDE wejście pól do formularza: wgrany plik, zlecenie z kolejki i pola ze
  Skrzynki.
- Zweryfikowane: 9 sprawdzeń logiki (`scratch-daty.test.mts` — weekend, święto, data już wpisana,
  ręczny tekst w brutto) i 5 w przeglądarce (`/test-data`, strona tymczasowa) NA TEJ SAMEJ ścieżce,
  którą zgłosił właściciel. **Test sprawdzony też odwrotnie**: po cofnięciu poprawki pole „Data"
  faktycznie wychodzi puste, czyli test łapie tę regresję, a nie tylko potwierdza poprawkę.

**„Mimo utworzenia zlecenia dalej je widzę i chcę drugi raz wpisać" — Skrzynka OZNACZA, nie chowa**
(zgłoszenie właściciela + doprecyzowanie: „mogą być dodane informacje poprzednio dodane, trzeba to
oznaczać, a nie z góry wywalać"):
- **Nie było to zawieszone oznaczanie maila jako przyjęty** — sprawdzone w bazie: statusy ustawiają
  się poprawnie (7 maili `accepted`, ostatni co do sekundy zgodny z ostatnim zleceniem). Przyczyna
  jest inna: **TO SAMO zlecenie przychodzi w KILKU mailach** (wątek, ponowna wysyłka, osobny mail
  z listem przewozowym), a zaakceptowanie jednego nie mówi nic o pozostałych. Konkret z produkcji:
  mail „Zlecenie transportowe / SRAF0376131 / CSNU1921289" wisiał jako nowy, choć zlecenie z tym
  kontenerem było w Zestawieniu od rana.
- **`matched_load_id` od pollera na to nie wystarcza**: dopasowuje po TEKŚCIE maila w chwili
  odczytu, więc zlecenie utworzone PÓŹNIEJ (albo z numerem, którego w mailu nie było — w tym
  przypadku numer zlecenia wyszedł z odczytu jako „2090 PLN z 13%baf") nigdy się nie dopasuje.
  Skrzynka liczy więc dopasowanie NA BIEŻĄCO z aktualnej listy zleceń, tą samą regułą, którą okno
  importu chroni przed duplikatem (numer — także z przestawionymi członami — a w drugiej kolejności
  kontener).
- **Mail zostaje na liście**, bo bywa nośnikiem NOWYCH informacji (zmiana terminu, dosłany
  dokument) — dostaje tylko oznaczenie: zielone „Już w Zestawieniu jako …" przy dopasowaniu po
  numerze (guzik zmienia się na „Dopnij do …", który wypełnia wyłącznie PUSTE pola) albo niebieskie
  „Możliwe, że to zlecenie …" przy samym kontenerze (ten sam kontener wraca po tygodniach na inne
  zlecenie, więc appka tego nie przesądza). Ukrycie maila zostaje decyzją dyspozytora („Odrzuć").
- **Migracja 0028** (ZAAPLIKOWANA): `email_attachments` miało politykę tylko na SELECT, więc zapis
  odczytu PER ZAŁĄCZNIK z przeglądarki („Odczytaj przez Claude") szedł w pustkę — RLS odfiltrowuje
  wiersze, a PostgREST zwraca wtedy sukces z zerem zmienionych wierszy, czyli błędu nie widać.
  Bez tej polityki rozdzielanie maila na kilka zleceń działałoby tylko dla dokumentów odczytanych
  przez pollera (service_role omija RLS).
- Zweryfikowane w przeglądarce (Playwright, tymczasowa strona `/test-skrzynka` z mailami
  wstrzykniętymi do cache TanStack Query) — 5 sprawdzeń: mail z tym samym numerem oznaczony jako
  „Już w Zestawieniu", mail z samym kontenerem tylko jako podpowiedź, mail o nieznanym zleceniu bez
  oznaczenia, komunikat mówiący wprost, że mail zostaje, i to, że ŻADEN mail nie znika z listy.

**TREŚĆ MAILA jest teraz czytana ZAWSZE, nie tylko przy mailu bez załącznika** (pytanie właściciela:
„czy program czyta także treść maila? tam czasami są informacje o dodatkowej stawce, przesunięciu"):
- Stan przed zmianą: treść była zapisywana, pokazywana (guzik „Treść maila", zakładka w podglądzie
  źródła) i używana do POWIĄZANIA maila ze zleceniem (prefiltr `mail-poll`), ale do modelu szła
  TYLKO wtedy, gdy mail nie miał żadnego załącznika. Mail z PDF-em i dopiskiem „stawka +200" albo
  „rozładunek przesuwamy na piątek" był więc czytany bez tego dopisku.
- Teraz „Odczytaj przez Claude" czyta dokumenty ORAZ treść. Tekst kosztuje ułamek odczytu PDF-a
  i dalej rusza wyłącznie z kliknięcia (zasada z incydentu z Claude Console bez zmian).
- **Dokument wygrywa, rozbieżność jest ostrzeżeniem, nie cichym nadpisaniem.** Mail bywa nowszy
  („przesuwamy na piątek"), ale bywa też źle odczytany — a wartość z dokumentu da się sprawdzić
  w podglądzie źródła obok. Dla ośmiu pól, przy których to ma znaczenie (data, godzina, stawka,
  termin płatności, kontener, numer zlecenia, podjęcie, cut off) appka pisze wprost: „Treść maila
  mówi X, a dokument Y — zostawiam wartość z dokumentu, popraw ręcznie, jeśli mail jest nowszy".
- Pola z treści dochodzą do formularza przez `ordersFromAttachments`: przy JEDNYM zleceniu na mailu
  scalają się z polami dokumentów (dokument pierwszy). Przy KILKU zleceniach nie są przypisywane —
  pola maila są wtedy zlepkiem kilku zleceń, więc appka mówi o tym w ostrzeżeniu i odsyła do
  zakładki „Treść maila", zamiast zgadywać, do którego zlecenia dopisek należy.
- Zweryfikowane: 18 sprawdzeń logiki (`scratch-grupy.test.mts` — w tym oba nowe przypadki: treść
  dochodzi do jedynego zlecenia, a przy kilku zleceniach nie dochodzi, ale zostawia ostrzeżenie).

**NAUKA Z DOKUMENTÓW JUŻ LEŻĄCYCH W STORAGE + naprawiona dziura w Skrzynce** (właściciel: „jak
recznie dzisiaj poprawiam babole to program sie uczy?" → nie; „jak mam dopiac pdf skoro na biezaco
sa one odczytywane z maila? nie mozemy zrobic jakiegos obejscia na czas nauki"):
- **Odpowiedź na pytanie wyjściowe: poprawka wpisana w KOMÓRCE TABELI nie uczy niczego.** Nauka
  siedzi w `handleSave` okna zlecenia i potrzebuje naraz tekstu dokumentu i pól zatwierdzonych przez
  człowieka; edycja inline nie ma dokumentu, więc nie ma gdzie szukać kotwic.
- **ZNALEZIONA DZIURA, prawdopodobna przyczyna zera szablonów mimo 6 zapisanych zleceń z PDF-ami**:
  `SkrzynkaPanel.otworzMaila` NIE ustawiał `materialDoNauki` — appka uczyła się WYŁĄCZNIE przy
  świeżym kliknięciu „Odczytaj przez Claude". Mail odczytany wcześniej (wynik zapisany przy
  wiadomości, drugie wejście darmowe) otwierał się bez tekstu dokumentów i zapisane z niego zlecenie
  nie zostawiało po sobie nic. Teraz tekst załączników wyciągany jest z bucketa przy otwarciu maila
  — **przed** `setOpenMail`, bo `ImportOrderDialog` bierze `initialLearningDocs` tylko przy
  montowaniu (dostarczone chwilę później nie trafiłoby do zapisu).
- `src/lib/orderTemplates/fromStored.ts` — pliki z Storage → `LearningDocument[]` (pobranie,
  opakowanie w `File`, ten sam `extractPdfText` co w oknie importu). `learningDocsFromStorage`
  (dowolny bucket: `order-emails` przy mailu, `load-documents` przy zleceniu) + `learningDocsFromStored`
  (dokumenty jednego zlecenia). POD/CMR pomijane — z nich szablon nigdy nie odtworzy kompletu
  kluczowych pól, więc zakładałyby tylko wieczne „kandydaty". Skan bez warstwy tekstowej to nie błąd,
  tylko granica metody — wraca jako komunikat, nie jako cisza.
- **Obejście na czas rozruchu — „Naucz z zapisanych zleceń (N)"** w oknie „Szablony": bierze PDF-y
  podpięte do zapisanych zleceń i uczy się z pól, które są przy tych zleceniach ZAPISANE (czyli
  także z poprawek wpisanych w tabeli). Zlecenia idą PO KOLEI, od najstarszych — o aktywacji
  szablonu decyduje para dokumentów tego samego układu, więc drugi musi zobaczyć wzorzec zapisany
  przez pierwszy; równolegle powstałyby dwa wiersze na ten sam układ. Zatrzymanie przez `ref`, nie
  przez stan (pętla czyta to w trakcie biegu). Nic nie zmienia w zleceniach i nie woła modelu.
- To samo dla JEDNEGO zlecenia: guzik **„Naucz appkę z tych dokumentów"** w oknie „Dokumenty".
- `loadToForm` wyjęte z `ImportOrderDialog` do `src/lib/loads/loadToForm.ts` — nauka wsteczna
  potrzebuje dokładnie tego samego przeliczenia rekordu na pola formularza.
- Świadomie BEZ `usedTemplateId`/`templateOutput` przy nauce wstecznej: dokument był czytany kiedyś
  i czymś innym, więc liczenie „poprawek dyspozytora" byłoby liczeniem cudzych pomyłek.
- **Zweryfikowane w przeglądarce** (Playwright, `next dev`, tymczasowa strona `/test-nauka`,
  skasowana po teście) na PRAWDZIWYM PDF-ie Q4Road, z podstawionym wyłącznie transportem
  (`supabase.storage.from().download()` → `fetch` pliku), resztą prawdziwego kodu: 2 dokumenty
  wczytane, JPEG i brakujący plik odbite z powodem, tekst 6089 znaków (**dokładnie tyle samo, co
  mierzone wcześniej przy odczycie tego pliku z dysku** — Blob nic nie gubi), pierwszy dokument →
  `kandydat` z 12 etykietami, drugi (te same rubryki, inne wartości) → **`aktywny`, 5 reguł**.
  **Pułapka testu, nie kodu**: pierwszy przebieg dał tylko 4 reguły i status `kandydat`, bo do
  „zatwierdzonych" wpisałem zmyśloną datę rozładunku — wartości, której w dokumencie nie ma, nauka
  nie zakotwiczy. Data odczytana z tekstu (03.07.2026) domknęła komplet.
- **NIE zweryfikowane na żywym koncie**: samo pobranie z prywatnego bucketa (środowisko sesji nie ma
  konta) — pierwsze kliknięcie właściciela pokaże, czy podpis do `order-emails` przechodzi.

**WAŻENIE — „czy wymagane" i „gdzie" (właściciel: „przy imporcie zleceń brakuje opcji zaciągania /
dopisania gdzie i czy wymagane jest ważenie"; w trakcie sesji doprecyzował: „jest Ważenie (export)
kolumna na to"):**
- **Miejsce ważenia zostaje w ISTNIEJĄCEJ kolumnie `weighing_export`** (kolumna R arkusza, „Ważenie
  (tylko export)") — na produkcji była pusta we wszystkich wierszach, więc nic nie trzeba było
  przenosić. Nazwa kolumny NIE zmieniona (siedzi w `activity_log` i w zapisanych ustawieniach widoku
  każdego użytkownika — ta sama zasada, co przy „Złożone kiedy" → „Data złożenia”), zmieniła się
  tylko etykieta: **„Ważenie gdzie”**. NOWA jest wyłącznie odpowiedź „czy”: `loads.weighing_required
  boolean` (migracja **0029**, ZAAPLIKOWANA przez MCP + `notify pgrst`).
- **Dlaczego osobna kolumna, a nie słowo doklejone do miejsca**: po „czy” dyspozytor filtruje dzień
  („które zlecenia trzeba zważyć”), a „tak” wpisane w tekst miejsca do niczego takiego się nie nadaje.
  Typ NULLOWALNY, bo trzy stany znaczą co innego: `true` = wymagane, `false` = wprost niewymagane,
  `null` = **dokument o tym nie mówi**. Wymuszenie `false` na braku informacji kazałoby dyspozytorowi
  ufać czemuś, czego nikt nie napisał (ta sama zasada, co przy `rate_includes_baf`).
- **Zaciąganie z dokumentu**: `parse-order-pdf` **wdrożona (v24)** — schemat ma `weighing_required` +
  `weighing_place`, doszła zasada 12 promptu (ważenie bywa jednym słowem w uwagach; wskazanie miejsca
  samo w sobie znaczy, że ważenie jest; nie mylić z wagą towaru ani z miejscem podjęcia/zdania).
  **Opis pola `notes` przestał zbierać ważenie** — dotąd stało tam wprost „np. nietypowe wymagania,
  ważenie”, i faktycznie tam lądowało: na produkcji zlecenie 441/1130/2026/KK/E ma w uwagach
  „…odprawa Piła, ważenie w porcie”, bo pola na to nie było.
- Reguła „**miejsce znaczy, że ważenie jest**" siedzi w `src/lib/loads/prepareOrder.ts`, czyli w tym
  JEDNYM miejscu, przez które przechodzi każde wejście pól do formularza (wgrany plik, kolejka
  dokumentów, Skrzynka, ręczne wpisanie) — dokładnie z powodu opisanego przy regresji domyślnej daty.
  Odwrotnie NIE działa: brak miejsca nie znaczy „niewymagane”, a świadome „nie” dyspozytora nie jest
  nadpisywane. Zmiana jest widoczna: okno pisze, że appka to zaznaczyła.
- **Naprawione przy okazji (dziura sprzed tej zmiany): na drodze ze SKRZYNKI ostrzeżenia
  `applyOrderDefaults` GINĘŁY.** Okno rozpakowywało wynik do samego `.order`, więc dyspozytor
  otwierający zlecenie z maila nie dowiadywał się, że appka przestawiła mu gestię na „Leasing”
  (a teraz — że zaznaczyła ważenie); przy wgranym pliku te same ostrzeżenia były pokazywane.
- **Pierwsza kolumna LOGICZNA w Zestawieniu** — `kind: "boolean"` w `columns.ts`: w komórce „Tak”/
  „Nie” (nigdy „true”), edycja listą z pustą opcją wracającą do „nie wiadomo”. Pusta komórka to brak
  informacji, nie „Nie”.
- **PUŁAPKA złapana testem, nie przy pisaniu: wyszukiwarka dopasowuje po FRAGMENCIE słowa**, więc
  „ważenie niewymagane” w indeksie sprawiało, że zapytanie „ważenie wymagane" wyciągało dokładnie te
  zlecenia, których dyspozytor wtedy NIE szuka („wymagane” siedzi w środku „niewymagane”). Zlecenie
  zwolnione opisujemy więc „bez ważenia”; jest test-straż na tę klasę błędu.
- **Zweryfikowane**: logika — 13 sprawdzeń (`scratch-wazenie.test.mts`, plik tymczasowy: normalizacja
  odpowiedzi modelu, scalanie dwóch dokumentów z zachowanym `false`, reguła miejsca, round-trip
  zapisane zlecenie → formularz, wyszukiwarka). Przeglądarka (Playwright, `next dev`, tymczasowa
  strona `/test-wazenie`, skasowana po teście) — 17 sprawdzeń **na prawdziwej ścieżce danych**
  (REST → `useLoads` → tabela → PATCH; podstawiony wyłącznie `fetch`, bo środowisko sesji nie ma
  konta): obie kolumny w tabeli, „Tak” zamiast „true”, pusta komórka przy braku informacji, edycja
  listą, zapis `false` i powrót do `null`, pola w oknie zlecenia, miejsce z dokumentu zaznaczające
  „wymagane” wraz z komunikatem. Baza — REST widzi nową kolumnę (brak PGRST204), filtr
  `weighing_required=is.true` działa; dziennik zmian obejmuje ją bez zmian w triggerze (0016 liczy
  diff generycznie z `to_jsonb`, pomijając tylko `updated_at`/`bhub_*`).
- **NIE zweryfikowane**: realny odczyt ważenia z dokumentu przez model. Od wersji v21 funkcja odrzuca
  wszystko, co nie jest tokenem ZALOGOWANEGO człowieka (blokada kosztowa po incydencie z Claude
  Console), a to środowisko konta nie ma — więc strzał curl-em potwierdza tylko, że funkcja wstała i
  chodzi po naszym kodzie (405 / `not_a_user`, polskie znaki całe). Pierwsze zlecenie z ważeniem
  u właściciela pokaże resztę.
- **`mail-poll` ŚWIADOMIE nie przewdrażana** (wdrożona v18 nie zna tych pól). Dziś nie ma to
  praktycznego skutku: poller nie woła modelu, szablon Q4Road ważenia nie czyta, a nauczonych
  szablonów jest zero. `shared/parsedOrder.ts` jest już przegenerowane, więc przy najbliższym
  wdrożeniu tej funkcji z innego powodu pola wejdą same.

**STAWKI DLA KIEROWCÓW — cennik po kodzie pocztowym i tonażu + miesięczne rozliczenie** (właściciel
przysłał arkusz „Zeszyt1.xlsx": Arkusz 1 to 283 wiersze `Kod / Miejscowość / do 15t / pow. 15t /
pow. 22t`; „potrzebuję żebyś dobudował funkcjonalność która automatycznie przypisze stawkę dla
kierowcy w zależności od zlecenia (kodu pocztowego/wagi) i potem pozwoli łatwo w skali miesiąca
pokazać stawki kierowcy w zestawieniu"). **Arkusze 2 i 3 świadomie nietknięte — właściciel:
„na razie nie zaglądaj, to z czasem wytłumaczę".**

**Decyzje właściciela (AskUserQuestion, ta sesja):**
- **O progu tonażu decyduje waga Z TERMINALA (Baltic Hub), gdy jest**, a gdy jej nie ma — waga
  z dokumentu. Kolejność w `weightForRate`: `bhub_gross_weight_kg` → liczbowa „Waga brutto" → towar
  + tara wg typu kontenera → sama waga towaru (ta ostatnia zaniża wagę o 2,2-4,8 t, więc jest
  ostrzeżeniem przy stawce, nie cichym założeniem).
- **Zlecenie wielopunktowe: liczy się NAJWYŻSZA stawka ze wszystkich miejsc** („kierowca jedzie
  najdalej"). Miejsce bez stawki w cenniku nie kasuje kwoty — dokłada ostrzeżenie.
- **Osobna zakładka „Stawki kierowców"** obok Zestawienia i Planu wspaniałego.

**Migracja 0030 (ZAAPLIKOWANA przez MCP w dwóch krokach — schemat i cennik — + `notify pgrst`):**
- `driver_rates`: `prefix` to SAME CYFRY, 2 albo 3 („06" i „061"), bo dopasowanie do kodu pocztowego
  zlecenia jest porównaniem prefiksu („80-299" → „80299" → próbuj „802", potem „80"). Zapis z arkusza
  („06-1") odtwarza UI (`formatRatePrefix`). Sprawdzone po zaaplikowaniu zapytaniem: 283 wiersze,
  220 trzycyfrowych, polskie znaki całe.
- **Cennik w BAZIE, nie w kodzie**: stawki się zmieniają (paliwo, nowa umowa), a wtedy zmiana ma być
  kliknięciem w appce, nie wdrożeniem — to samo rozstrzygnięcie co przy `contractors`
  i `order_templates`. RLS „wymaga logowania", Realtime włączony (dwóch dyspozytorów, jedna prawda).
- `loads.postal_code` — appka NIE MIAŁA gdzie trzymać kodu pocztowego (adres to wolny tekst, a w
  danych produkcyjnych nie było ani jednego kodu), a to on decyduje o stawce.
- **`loads.driver_rate` (kolumna Y arkusza) zmieniła TYP z text na numeric**, nie nazwę — nazwa siedzi
  w `activity_log` i w zapisanych ustawieniach widoku każdego użytkownika (ta sama zasada co przy
  „Złożone kiedy" i „Ważenie gdzie"). Konwersja bezpieczna: sprawdzone zapytaniem, że na produkcji
  nie było ani jednej wypełnionej wartości. Do tego `driver_rate_code` (z którego wiersza cennika)
  i `driver_rate_source` (`auto`/`manual`).

**Reguły dopasowania (`src/lib/driverRates/rates.ts`) — appka NIGDY nie zgaduje:**
- Bardziej szczegółowy wiersz wygrywa: najpierw 3 cyfry („06-1" Pułtusk), potem 2 („06" Mława).
  Arkusz ma sześć prefiksów z jednym i drugim naraz, więc to nie jest teoria.
- **Kod spoza cennika = BRAK stawki + powód wypisany wprost**, nigdy stawka sąsiada. Arkusz ma
  08-1…08-5 i NIE ma ogólnego „08", a prefiksu 79 nie ma w ogóle — podstawienie sąsiedniego wiersza
  byłoby kwotą do wypłaty wziętą z sufitu.
- Kod pocztowy wyłuskiwany z adresu, gdy nie ma go w polu („Słoneczna 42 A, 05-500 Piaseczno") —
  w `prepareOrder.ts`, czyli w tym jednym lejku, przez który przechodzi każde wejście pól do
  formularza. Wymagany PEŁNY kształt NN-NNN: „Sygnały 62" nie jest kodem.
- **Nazwa miejscowości to ostatnia deska ratunku i tylko wtedy, gdy WSZYSTKIE trafione wiersze mają
  identyczne stawki** (Warszawa 00-04 i Łódź 90-94 — tak; miasto rozstrzelone po różnych stawkach —
  nie). Kolumna „Miejscowość" jest opisem prefiksu, nie adresem („Mława/Przasnysz", „Okolice
  Warszawy"), więc każde inne użycie byłoby zgadywaniem. Wynik jest oznaczony jako słabsze
  dopasowanie i pisze wprost, żeby wpisać kod.
- Progi: „do 15t" obejmuje RÓWNE 15 t, „pow. 22t" to dopiero > 22 t. W arkuszu pierwsze dwie kolumny
  są często równe, więc pomyłka na tej granicy byłaby długo niewidoczna — stąd osobne testy.

**Kiedy appce wolno ruszyć stawkę (`assign.ts`)** — jedno miejsce na tę granicę: tylko gdy
`driver_rate_source` NIE jest `manual`. Kwota wpisana ręcznie w tabeli albo w formularzu jest
nietykalna, a **świadome wyczyszczenie pola też jest decyzją człowieka** i nie wraca (formularz
wtedy nie podpowiada). Źródło rozstrzyga porównanie z wyliczeniem: kwota równa podpowiedzi to
`auto`, każda inna `manual` — dzięki temu nie ma osobnego pola „czy to ja wpisałem", którego
dyspozytor musiałby pilnować.

**Gdzie siedzi reguła — i dlaczego NIE w `prepareOrder.ts`.** Wszystkie trzy drogi (podpowiedź
w oknie zlecenia, edycja inline w tabeli, przeliczanie zbiorcze) wołają `computeDriverRate`.
Kuszące było dołożyć stawkę do `applyOrderDefaults` (tam siedzą domyślna data, brutto z tary
i gestia z uwag), ale cennik przychodzi z bazy ASYNCHRONICZNIE, a `applyOrderDefaults` bywa wołane
w inicjalizatorze stanu okna — czyli czasem zanim cennik dojedzie, i stawka wychodziłaby raz tak,
raz tak. Okno liczy ją więc na żywo (`useMemo`), co przy okazji pokazuje kwotę od razu po poprawce
kodu czy wagi. W `prepareOrder.ts` stoi komentarz, żeby nikt tego nie „naprawił".

**Co się dzieje samo:** import/ręczne zlecenie podpowiada stawkę w formularzu (z jednym zdaniem
„skąd ta kwota"), a zapis niesie ją razem z kodem cennika i źródłem. Edycja inline kodu pocztowego,
wagi netto, brutto, typu kontenera albo kolejnych miejsc przelicza stawkę W TYM SAMYM zapisie —
dokładnie tak, jak zmiana wagi przelicza brutto.

**Zakładka „Stawki kierowców"** (`src/components/stawki/`): wybór miesiąca (po kolumnie „Data",
bo to dzień, na który zlecenie jest zaplanowane; zlecenia bez daty mają własną szufladę „Bez daty"),
wiersz per kierowca z sumą i licznikiem „bez stawki"/„ręcznie", po rozwinięciu jego zlecenia
z wyjaśnieniem przy każdym. Do tego „Przelicz stawki z cennika" (pomija ręczne i mówi o tym wprost),
„Pobierz CSV" (średnik + przecinek dziesiętny + BOM, żeby polski Excel otworzył to bez rozsypanych
ogonków) i boczny „Cennik stawek" — podgląd, poprawianie kwot i dopisanie kodu bez wdrożenia.

**`parse-order-pdf` wdrożona (v25)**: schemat ma `postal_code` (i to samo pole przy każdym kolejnym
miejscu w `extra_stops`), a zasada 13 promptu mówi wprost, żeby brać kod z adresu DOSTAWY, nie
z nagłówka zleceniodawcy, i nie zgadywać go z nazwy miasta. Wdrożenie sprawdzone: `get_edge_function`
zwraca wysłaną treść, a strzały curl-em dają NASZE komunikaty (405, `not_a_user`) z całymi polskimi
znakami.

**Dwa błędy złapane testem w przeglądarce, nie przy pisaniu:**
1. Filtr cennika po nazwie miasta nie zawężał NICZEGO: warunek `prefix.startsWith(szukaj bez cyfr)`
   przy zapytaniu „Rybnik" sprowadzał się do `startsWith("")`, czyli „pasuje każdy wiersz". Cyfry
   porównujemy teraz tylko wtedy, gdy zapytanie w ogóle jakieś ma.
2. Zlecenie bez stawki, dla której cennik MA odpowiedź, pokazywało pustą rubrykę „skąd" — czyli
   dyspozytor nie miał skąd wiedzieć, że wystarczy kliknąć „Przelicz". Teraz pisze wprost, ile by
   wyszło.

**Zweryfikowane:** logika — 61 sprawdzeń (`scratch-stawki.test.mts`, plik tymczasowy), przy czym
**cennik do testów czytany jest z migracji 0030**, czyli z tych samych 283 wierszy arkusza, które
poszły na produkcję (test na trzech wymyślonych wierszach potwierdzałby wyłącznie sam siebie).
Przeglądarka (Playwright, `next dev`, tymczasowa strona `/test-stawki`, skasowana po teście) —
33 sprawdzenia NA PRAWDZIWEJ ŚCIEŻCE (podstawiony wyłącznie `fetch`, bo środowisko sesji nie ma
konta): obie nowe kolumny w Zestawieniu, edycja kodu i wagi przeliczająca stawkę w jednym PATCH-u,
ręczna kwota oznaczona jako `manual`, formularz nowego zlecenia podpowiadający 550 zł i zapisujący
je razem z kodem `44-2`, przeliczanie miesiąca dotykające dokładnie jednego zlecenia (ręcznego nie
tknęło), sumy per kierowca i per miesiąc, cennik z filtrowaniem. Baza — REST widzi nowe kolumny
(brak PGRST204), zapis bez sesji odbity przez RLS.
**NIE zweryfikowane na żywym koncie** (środowisko sesji nie ma konta): zapis stawki z przeglądarki
na produkcji oraz to, czy model faktycznie zwraca `postal_code` z prawdziwego dokumentu — pierwsze
zlecenie u właściciela to pokaże. Sześć zleceń, które są dziś w bazie, nie ma kodów pocztowych;
część z nich złapie się po nazwie miasta (Rybnik, Łódź, Jasło), reszta czeka na wpisanie kodu.
**`mail-poll` NIE przewdrożona** (wdrożona v18 nie zna `postal_code`) — propozycje ze skrzynki
przychodzą bez kodu, dyspozytor uzupełnia go w formularzu albo appka wyłuskuje go z adresu.
`shared/` jest już przegenerowane, więc wystarczy `supabase functions deploy mail-poll
--project-ref itlgexjhznjsbonzdxyg` (przez MCP trzeba by wklejać cały bundle).

**Skąd biorą się KODY POCZTOWE — bo „przecież są zawsze w zleceniach"** (pytanie właściciela po
pierwszej wersji stawek; słuszne):
- **Zmierzona przyczyna, nie domysł: na 115 dokumentów odczytanych przez Claude PRZED tą sesją tylko
  11 miało kod pocztowy w polu adresu (`email_attachments.parsed`), a w polu miejscowości — zero.**
  Kod stoi w dokumentach, ale appka o niego NIE PYTAŁA: schemat funkcji nie miał takiego pola, więc
  model oddawał samą ulicę. Szablon Q4Road kod widzi (jego regex wyłuskuje z niego miejscowość),
  ale też nie zapisywał go osobno.
- Stąd trzy drogi, w tej kolejności, wszystkie darmowe poza pierwszą:
  1. `parse-order-pdf` v25 pyta o `postal_code` wprost (i o kod przy każdym kolejnym miejscu).
  2. `applyOrderDefaults` wyłuskuje kod z pola adresu („RYDZYNSKA 24F 64-125", „ul. Magazynowa 3,
     55-080 Kąty Wrocławskie" — obie formy są w danych klienta).
  3. **`postalCodeNearCity` — kod z SUROWEGO TEKSTU dokumentu, szukany PRZY nazwie miejscowości,
     którą już znamy z odczytu.** To nie jest „znajdź jakiś kod w PDF-ie": w dokumencie stoją też
     kody spedytora i agencji celnej. Gdy przy tej samej miejscowości stoją RÓŻNE kody, appka nie
     wybiera żadnego. Działa przy wgrywaniu pliku ORAZ przy zleceniu ze Skrzynki (teksty załączników
     i tak są pobierane do nauki szablonów).
- **Guzik „Uzupełnij kody z dokumentów (N)"** w zakładce Stawki kierowców robi to samo dla zleceń
  JUŻ ZAPISANYCH: pobiera ich PDF-y ze Storage, wyciąga tekst przez pdf.js i uzupełnia kod razem
  z przeliczoną stawką. Nie woła modelu, więc nic nie kosztuje.
- **Przy okazji poprawione: `learningDocsFromStorage` miało wpisany na sztywno próg 300 znaków
  tekstu** („skan bez warstwy tekstowej"). To reguła NAUKI (kotwice potrzebują sensownego kawałka
  tekstu), a nie własność pliku — krótkie jednostronicowe zlecenie ma pełnoprawny adres z kodem.
  Próg jest teraz parametrem; uzupełnianie kodów podaje własny. Złapane testem w przeglądarce:
  pierwszy przebieg raportował „bez kodu przy miejscowości", choć kod w dokumencie stał.
- Zweryfikowane: 18 sprawdzeń logiki (`scratch-kody.test.mts`, plik tymczasowy) na formatach
  WZIĘTYCH Z PRODUKCJI (zapytanie do `email_attachments`), w tym kod w kolejnej linii pod etykietą,
  dwa różne kody przy tej samej nazwie (= brak odpowiedzi) i nazwa miasta w środku innego słowa
  („Ujazdowskich" ≠ „Ujazd"). Przeglądarka (Playwright, tymczasowa strona `/test-kody`, skasowana
  po teście) — 11 sprawdzeń na CAŁEJ drodze: prawdziwy (wygenerowany) PDF z warstwą tekstową
  podstawiony jako plik ze Storage → pdf.js → kod 44-200 zapisany przy zleceniu → stawka 500 zł
  przeliczona w tym samym zapisie → guzik znika, bo nie ma już zleceń bez kodu.
- **Pułapka środowiska sesji** (nie appki): w przeglądarce testowej KAŻDE prawdziwe wyjście w sieć
  wisi bez błędu (mock obejmuje tylko `/rest/v1/`), więc pobranie ze Storage nie kończyło się ani
  sukcesem, ani błędem. Stąd podstawienie `/storage/v1/object` w mocku — bez tego test wyglądałby
  na zawieszenie appki.

**`mail-poll` WDROŻONA (v19) — skrzynka też bierze kody pocztowe:**
- Poller ma teraz tę samą regułę co przeglądarka (`shared/postalFromText.ts` z
  `scripts/build-edge-shared.mjs`): po odczycie dokumentu szuka kodu PRZY miejscowości z tego
  dokumentu, a po scaleniu załączników jeszcze raz — bo miasto bywa w zleceniu, a kod w liście
  przewozowym. Propozycja w Skrzynce przychodzi więc z kodem, a nie dopiero po otwarciu okna.
- **Szablon Q4Road zapisuje kod osobno** (`parseUnloadingRow`): ten sam regex widział go od zawsze,
  ale służył wyłącznie do odcięcia miejscowości. Sprawdzone na wierszu w kształcie, jaki produkuje
  pdf.js: „ul. Zwirowa 73, 54-029 Wrocław" → kod 54-029, miasto „Wrocław".
- **Dwie pułapki wdrożenia, obie potwierdzone w praktyce w tej sesji:**
  1. `verify_jwt` MUSI iść jawnie jako `false` (cron woła funkcję sekretem `x-ingest-secret`, bez
     JWT) — domyślka MCP to `true` i odcina odczyt skrzynki.
  2. Pominięcie `import_map_path` kończy się błędem „import map path does not exist" ze SKLEJONĄ
     ścieżką z poprzedniej wersji (dosłownie: `…_19/source/file:///…_18/source/deno.json`).
     Podawać `import_map_path: "deno.json"` i dołączać `deno.json` do plików.
- Wdrożone jako bundle (esbuild, `--charset=utf8`, 48 kB) — `bundle.js` jest artefaktem i wchodzi
  do `.gitignore`; źródłem prawdy zostają pliki `.ts`. Przed wdrożeniem: `deno check` + 26 testów
  Deno przechodzi.
- Sprawdzone po wdrożeniu: strzał curl-em daje NASZE komunikaty (405 i 401, polskie znaki całe),
  a przebieg crona po wdrożeniu kończy się bez błędu (`email_ingest_state.last_error` puste,
  `seen_total` rośnie). **Czego nie da się sprawdzić z tej sesji: czy kod faktycznie wyszedł
  z prawdziwego maila** — potrzeba nowego zlecenia w skrzynce; widać to będzie w Skrzynce przy
  pierwszej propozycji (pole „Kod pocztowy" w oknie zlecenia — od zmiany niżej: pole „Adres").

**TRZY KOLUMNY SCALONE — bo powtarzały to, co już widać** (właściciel po obejrzeniu Zestawienia:
„nie rozumiem, dlaczego wydzieliliśmy — przecież czy to jest import czy eksport widzimy od razu.
Kod pocztowy powinien być w adresie, a ważenie już mamy kolumnę ważenie gdzie — to jest to samo"):
- **Kolumna „Kierunek" USUNIĘTA.** Kierunek jest nagłówkiem bloku w dniu (KRAJÓWKA / EKSPORT /
  IMPORT), więc kolumna powtarzała go przy każdym wierszu. Nie zginęła możliwość ZMIANY kierunku —
  po to przy wierszu stoi nowy guzik **„Popraw"**: to samo okno co przy imporcie, z rekordem
  wczytanym do pól (`mode="edit"`, istniało od dawna, tylko nikt go stamtąd nie otwierał). Jest to
  też droga do pól, których w tabeli nie ma.
- **Kolumna „Kod pocztowy" USUNIĘTA — kod jest częścią adresu.** `loads.postal_code` ZOSTAJE
  w bazie (liczy się z niego stawka kierowcy, filtry go szukają), ale nikt go już nie wypełnia
  osobno: wylicza się z adresu (`src/lib/loads/address.ts`). Komórka „Adres" pokazuje adres razem
  z kodem (dopisuje go, gdy w treści adresu go nie ma — tak przychodzi z odczytu dokumentu),
  edytor startuje od TEGO SAMEGO tekstu, a Enter zapisuje adres i wyliczony z niego kod jednym
  PATCH-em (razem z przeliczoną stawką). Dzięki temu nie da się mieć w adresie jednego kodu, a
  w stawce drugiego. `applyOrderDefaults` dopisuje kod do adresu przy KAŻDYM wejściu pól do
  formularza (jedyny lejek — patrz regresja domyślnej daty), więc dotyczy to też Skrzynki.
  W oknie zlecenia zamiast pola „Kod pocztowy" jest zdanie pod adresem: jaki kod appka wyłuskała
  albo że go nie ma (a wtedy cennik nie poda stawki).
- **Ważenie w JEDNEJ kolumnie** (`weighing_export`, etykieta „Ważenie"). W komórce stoi miejsce,
  a gdy miejsca nie znamy — samo „Tak"/„Nie"; pusto dalej znaczy „dokument o tym nie mówi" i NIE
  jest odpowiedzią „nie". Wpisany tekst rozkłada się na dwie kolumny bazy (`src/lib/loads/
  weighing.ts`): „tak"/„nie" to sama odpowiedź, każdy inny tekst to miejsce (i tym samym „tak"),
  puste kasuje jedno i drugie. Obie kolumny bazy zostają — `weighing_required` niesie odpowiedź
  także bez miejsca i po niej filtruje się dzień. W oknie zlecenia też jedno pole zamiast dwóch.
- **BEZ migracji i bez zmian schematu** — zmieniło się to, co widać i co wypełnia człowiek, nie to,
  co stoi w bazie. Zapisane ustawienia widoku (`user_view_settings`) same przestają pokazywać
  usunięte kolumny: `resolveColumns` odsiewa klucze, których nie ma w `COLUMNS`.
- Sprawdzone w bazie PRZED zmianą (żeby nie scalać na ślepo): z 10 zleceń 4 mają kod pocztowy,
  3 z nich mają go też w adresie, a ważenie jest wszędzie puste — czyli scalenie niczego nie gubi.
- **Pułapka (trzeci raz w tym repo): polski cudzysłów „…" wewnątrz napisu w `"…"` ZAMYKA napis.**
  Trafiło w placeholder JSX i w plik testu; w JSX złapał to `tsc`, w teście `node --check`. Cytat
  w atrybucie albo w napisie zapisywać przez apostrofy, nie przez `"`.
- **Zweryfikowane**: logika — 27 sprawdzeń (`scratch-kolumny.test.mts`, plik tymczasowy: dopisanie
  kodu, adres z innym kodem, round-trip „to, co widać, zapisuje się bez zmian", trzy stany ważenia,
  reguły wejściowe, stawka licząca się z kodu stojącego w adresie). Przeglądarka (Playwright,
  `next dev`, tymczasowa strona `/test-kolumny`, skasowana po teście) — 27 sprawdzeń NA PRAWDZIWEJ
  ŚCIEŻCE (podstawiony wyłącznie `fetch`, bo środowisko sesji nie ma konta): brak trzech kolumn,
  nagłówki bloków na miejscu, kod dopisany do adresu, edycja adresu zapisująca kod i stawkę jednym
  PATCH-em, „nie"/miejsce w ważeniu, guzik „Popraw" otwierający okno i przestawiający kierunek na
  krajówkę. `npm run build` przechodzi.
- **NIE zweryfikowane na żywym koncie** (środowisko sesji nie ma konta): zapis z produkcji.
  `mail-poll` nie wymaga wdrożenia — cała zmiana jest po stronie przeglądarki; propozycja ze
  skrzynki dostaje kod dopisany do adresu w oknie zlecenia i to wystarczy.

**BCT i GCT ODPYTUJE SERWER, wtyczka zostaje przy BHubie i jako zabezpieczenie** (reguła
właściciela wprost: „BHub i strony wymagające logowania — wtyczka; strony publiczne bez logowania —
natywna obsługa (o ile będzie możliwa) z dobudowaną funkcjonalnością po stronie wtyczki, gdyby się
wysypało"):
- **Zmierzone w tej sesji, nie założone**: BCT to publiczny formularz ASP.NET (GET po
  `__RequestVerificationToken` → POST na `/Tiles/TileCheckContainerSubmit`), GCT — PRADO (GET po
  `PRADO_PAGESTATE` → POST na tę samą stronę). Dwa zwykłe zapytania HTTP, żadnego Cloudflare.
  **To NIE jest ta sama ściana, o którą rozbił się Baltic Hub**, choć wygląda podobnie (oba
  wymagają tokenu z wcześniej pobranej strony, jak „Page Expired" z `/multi`): tam Cloudflare nie
  pozwalał POBRAĆ strony, więc świeżego tokenu nie dało się zdobyć. Tu GET przechodzi.
- **Rozstrzygnięta niewiadoma, która przesądzała o sensie całości: adresy wyjściowe Supabase SĄ
  przez te terminale przyjmowane.** Pierwszy przebieg na produkcji odczytał wszystkie cztery
  zlecenia BCT/GCT bez jednego błędu (`updated: 4`, `problems: []`), z prawdziwymi danymi:
  MSBU3142439 DEPARTED/MSC/10250/8150, OOCU0555210 → **ZP** (reguła „YARD + brak stopek"),
  oba GCT „na terminalu" z pustym czasem podjęcia. Edge Functions nie mają stałego IP, więc bez
  tego sprawdzenia cała droga byłaby hipotezą.
- **JEDEN parser, dwa transporty.** Z serwera dostajemy HTML, z wtyczki widoczny tekst
  (`innerText`), więc HTML sprowadza do tego samego kształtu `htmlText.ts` (tabulator = komórka,
  złamanie linii = wiersz), a `parse.ts` nie wie, skąd przyszedł tekst. Dwa odczyty rozjechałyby
  się przy pierwszej poprawce. Jest test-straż: BCT z serwera i BCT z wtyczki dają identyczne pola.
  **`&nbsp;` MUSI przeżyć normalizację** — pustą komórkę GCT zapisuje właśnie tak, a bez niej
  ostatnia kolumna wiersza skleja się z pierwszą kolumną następnego.
- **BŁĄD ZNALEZIONY PRZY OKAZJI, dotyczył TAKŻE wtyczki i siedział w kodzie od 0032**: `parseGct`
  dzielił pola co `kolumny.length`, a granicę wiersza niesie ZŁAMANIE LINII — więc ostatnia komórka
  wchłaniała numer porządkowy następnego wiersza. „Data/Czas podjęcia" wychodziła „2", czyli appka
  twierdziła, że kontener został PODJĘTY, choć rubryka była pusta, a kolejne kontenery z paczki
  przesuwały się o jedno pole i nie dawały się odnaleźć. GCT pytamy paczkami po 10, więc dotyczyło
  to każdej paczki poza jednoelementową; złapane dopiero na prawdziwej odpowiedzi o DWA kontenery.
  Naprawione (`wierszeGct`) — tniemy tylko OSTATNIĄ komórkę i tylko gdy po złamaniu linii zostaje
  sam numer porządkowy. Dwa testy-straże, **sprawdzone odwrotnie**: na kodzie sprzed poprawki padają.
  Przy okazji: GCT wypisuje nieznany kontener jako zwykły wiersz ze słowami „brak informacji" —
  teraz to `notFound`, a nie status.
- **Migracja 0033** (ZAAPLIKOWANA + sprawdzona zapytaniem): `terminal_sources` (terminal → `serwer`
  / `wtyczka`) i cron co 15 minut. **Droga siedzi w BAZIE, nie w kodzie — to jest owo
  zabezpieczenie**: gdy BCT albo GCT zacznie się bronić, przestawienie jednego wiersza oddaje go
  wtyczce, bez wdrożenia i bez aktualizacji rozszerzenia u dyspozytorów. Wtyczka NIE TRACI żadnej
  umiejętności — dalej umie wszystkie trzy terminale, tylko w cyklu ich nie dostaje (pustą listę
  znosi bez zmian w kodzie: „nic do sprawdzenia"). Przełącznik w oknie „Wtyczka" → „Skąd biorą się
  statusy"; przestawienie BHuba na `serwer` jest opatrzone ostrzeżeniem (403 przy każdym zleceniu).
- **Cron używa TEGO SAMEGO sekretu `INGEST_SECRET` co skrzynka mailowa** — jest już w Vaulcie i w
  sekretach Edge Functions, więc odczyt ruszył od razu. MCP nie ustawia sekretów, więc każdy nowy
  oznaczałby ręczny krok właściciela i funkcję milczącą do tego czasu. `verify_jwt: false` jest tu
  KONIECZNE (cron woła bez JWT), a autoryzację robi sam kod: token użytkownika albo sekret, przy
  czym sekret uprawnia WYŁĄCZNIE do `cykl`.
- Migracja **0034** — jednorazowy rozruch: wdrożenie wypadło w sobotę wieczorem, a cykl chodzi
  w oknie „dni robocze 6-18", więc pierwsza odpowiedź przyszłaby dopiero w poniedziałek. `loadIds`
  liczone z bazy (nie na sztywno) pomijają okno, tak jak kliknięcie dyspozytora.
- Appka: `checkTerminalStatus.ts` woła `cykl`, a `useBhubCheck` pyta NAJPIERW serwer i dopiero to,
  co serwer odda jako `dlaWtyczki`, kieruje do rozszerzenia. **Podział terminali rozstrzyga
  wyłącznie serwer** — gdyby appka dzieliła to sama, przestawienie drogi wymagałoby wdrożenia appki.
  Skutek uboczny, o który chodziło: dyspozytor bez wtyczki nie dostaje już komunikatu o jej braku,
  kiedy nie była do niczego potrzebna. Przebieg serwerowy melduje się w `bhub_agent_state` jak
  każde rozszerzenie, więc martwy odczyt widać niezależnie od tego, która droga zamilkła.
- Funkcja `bhub-status` wdrożona (**v40**) jako paczka esbuild. **Po zbudowaniu dosłowne tabulatory
  i twarde spacje w napisach zamieniane są na sekwencje ucieczki** (`scripts` tego nie robią —
  robione ręcznie, patrz komentarz na górze `bundle.js`): esbuild rozwija `\t`, a niewidoczne znaki
  gubią się przy przenoszeniu treści przez MCP. Że przeżyły, wiadomo nie z porównania bajtów, tylko
  z zachowania — GCT bez tabulatorów w ogóle by się nie sparsował, a sparsował się na produkcji.
- **Czego NIE zweryfikowano**: zapisu przełącznika `terminal_sources` z przeglądarki na żywym koncie
  (środowisko sesji go nie ma) — polityki, granty i Realtime sprawdzone zapytaniem, a odczyt bez
  sesji odbity przez RLS (`[]` przez klucz publishable). Nie widziano też jeszcze, jak zachowa się
  cykl automatyczny w oknie godzinowym — pierwszy taki przebieg wypada w poniedziałek o 6:00.

**Do zrobienia w kolejnej sesji:**
0. Kolejne przykłady zleceń od nowych spedytorów — po każdym sprawdzić, czy Haiku 4.5 nadal daje
   radę (jeśli nie: `MODEL` → `claude-sonnet-5`), i czy któryś spedytor powtarza się na tyle często,
   żeby opłacał się deterministyczny szablon zamiast płatnego odczytu.
2. Więcej przykładów zleceń od innych spedytorów → kolejne pliki w `src/lib/orderTemplates/`
   (wzorzec: `detect` po nagłówku dokumentu + nazwie spedytora, `parse` etykieta→etykieta przez
   `between()`, nigdy `$`).
3. Kontrola kosztu odczytu przez Claude: pierwszy próg już stoi (płatny odczyt tylko z kliknięcia
   zalogowanego człowieka, automaty dostają 403 — patrz sekcja o Claude Console). Zostaje pytanie
   o LIMIT NA OSOBĘ, jeśli okaże się potrzebny — świadoma decyzja do podjęcia z właścicielem, nie
   kopiować `is_manager()` z DAB bez pytania.
4. Edycja inline: nawigacja Tab/strzałkami między komórkami, jeśli dyspozytorzy o to poproszą.
6. Widok: przeciąganie nagłówków (dziś kolejność ustawia się strzałkami w oknie "Widok") i
   ewentualnie nazwane widoki do przełączania ("Dyspozytor", "Fakturowanie") — konfiguracja jest
   już obiektem w jsonb, więc jedno i drugie da się dołożyć bez migracji. Do zrobienia dopiero,
   gdy właściciel powie, że tego chce.
5. Dla eksportu: domyślna data liczy się dziś od `delivery_date` (jedyna data z szablonu Q4Road, tam
   "Miejsca rozładunku"). Gdy pojawi się zlecenie eksportowe z datą ZAŁADUNKU, upewnić się, że parser
   szablonu wpisuje ją tak, żeby "dzień roboczy przed" liczył się od właściwej daty.
7. **Baltic Hub — pierwsze uruchomienie rozszerzenia u właściciela** (patrz sekcja wyżej):
   zainstalować z `extension/README.md`, zalogować, kliknąć „Sprawdź teraz" i obejrzeć, co wyszło.
   Gdyby odczyt nie trafił: w `bhub_details` przy zleceniu leży migawka (spis pól, guziki, tekst
   strony) — poprawiać `page.js` (wybór pola/guzika) albo `LABELS`/etykiety karty w `parse.ts`,
   nigdy na ślepo. Przy okazji dopytać właściciela o znaczenie statusów, których strona pokaże
   więcej niż pięć ustalonych („z czasem będę Ci tłumaczył") — dziś nieznane wracają jako surowy
   tekst bez koloru.
8. Gdyby Baltic Hub dał jednak API: transport wraca po stronie serwera, ale `pending`/`report`
   zostają — wtedy dochodzi trzecie źródło obok rozszerzenia, a nie przepisywanie całości.
9. Skrzynka: przy pierwszym mailu z DWOMA zleceniami sprawdzić na produkcji całą drogę (rozdzielenie
   po numerze → zapis pierwszego → wczytanie drugiego → podpięcie właściwych załączników). Logika ma
   testy, ale na żywym mailu jeszcze nie chodziła.
10. Wielopunktówka a Plan wspaniały: dziś zlecenie stoi w kolumnie swojej JEDNEJ daty, a kolejne
   miejsca są tylko opisem na kafelku („+ N miejsc"). Gdyby okazało się, że wielopunktowe zlecenie
   ma zajmować auto w kilku dniach, to osobna decyzja z właścicielem — nie zakładać jej z góry.
12. Ważenie: kafelek „Planu wspaniałego" go nie pokazuje, a ważenie zajmuje kierowcy czas w dniu —
   do rozważenia z właścicielem, czy ma tam stać (dziś widać je tylko w Zestawieniu i w oknie
   zlecenia). Szablon Q4Road (`q4road.ts`) też nie czyta ważenia — do dopisania, gdy pojawi się ich
   zlecenie z taką rubryką (nie zgadywać regexa bez dokumentu, patrz pułapka z kotwicą `$`).
13. Stawki kierowców: Arkusz 2 i 3 przysłanego pliku czekają na wyjaśnienie właściciela („z czasem
   wytłumaczę") — NIE otwierać ich bez tego. Do dopytania przy pierwszym rozliczeniu miesiąca: czy
   ktoś ma dostawać dodatek za ważenie/wielopunktówkę (dziś stawka zależy wyłącznie od kodu i wagi)
   i czy cennik ma mieć wersje (od kiedy obowiązuje) — dziś poprawka stawki działa wstecz na
   przeliczane zlecenia, a zapisane kwoty zostają.
11. Krajówka na fakturze: trasa to dziś same miejscowości (`buildRoute`), bo zlecenie nie ma pola
   „miejsce załadunku" osobno od miejsca rozładunku. Jeśli właściciel będzie chciał pełną trasę
   „skąd — dokąd", potrzebne będzie to pole (albo pierwsze miejsce z listy jako załadunek).
