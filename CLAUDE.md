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
2. **Edge Function przez Claude API (`supabase/functions/parse-order-pdf/index.ts`) — ZBUDOWANA, ale
   ŚWIADOMIE NIEPODŁĄCZONA pod UI.** Zostaje jako gotowy, docelowy fallback dla NIEznanych szablonów
   ("z czasem dopiero claude console") — `src/lib/supabase/parseOrderPdf.ts` (helper wołający ją) też
   zostaje, po prostu `ImportOrderDialog.tsx` go dziś nie wywołuje. Gdy przyjdzie czas na podłączenie:
   wywołać ten helper jako fallback w `handleFileChange`, gdy `matchKnownTemplate` zwróci `null`.
   Funkcja wzorowana WPROST na `bochanw/DAB/supabase/functions/parse-order-pdf` (ten sam kontrakt:
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

**Do zrobienia w kolejnej sesji:**
1. Właściciel aplikuje `0003_activity_log.sql`; potem pierwszy test panelu "Historia" na żywo (bez
   migracji panel pokaże błąd "relation activity_log does not exist" / brak w schema cache).
2. Więcej przykładów zleceń od innych spedytorów → kolejne pliki w `src/lib/orderTemplates/`
   (wzorzec: `detect` po nagłówku dokumentu + nazwie spedytora, `parse` etykieta→etykieta przez
   `between()`, nigdy `$`).
3. Podłączyć Edge Function jako fallback dla nierozpoznanych szablonów, gdy właściciel zdecyduje że
   pora ("z czasem dopiero claude console") — kod po obu stronach gotowy, brakuje wywołania w
   `ImportOrderDialog.tsx` + wdrożenia funkcji/sekretu. UWAGA: schemat narzędzia w Edge Function
   NIE zna 10 nowych pól z listu przewozowego — dopisać przy podłączaniu.
4. Edycja inline: nawigacja Tab/strzałkami między komórkami, jeśli dyspozytorzy o to poproszą.
5. Dla eksportu: domyślna data liczy się dziś od `delivery_date` (jedyna data z szablonu Q4Road, tam
   "Miejsca rozładunku"). Gdy pojawi się zlecenie eksportowe z datą ZAŁADUNKU, upewnić się, że parser
   szablonu wpisuje ją tak, żeby "dzień roboczy przed" liczył się od właściwej daty.
