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
