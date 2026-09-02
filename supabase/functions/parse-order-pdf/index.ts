// ============================================================
// parse-order-pdf — wyciąga pola zlecenia spedycyjnego z PDF-a przez model Claude
// ============================================================
// Guzik "Importuj zlecenie (PDF)" w Zestawieniu (patrz src/components/zestawienie/
// ImportOrderDialog.tsx) — właściciel NIE chce ręcznie przepisywać pól z każdego zlecenia PDF do
// formularza. Appka najpierw próbuje szablonów znanych klientów (src/lib/orderTemplates/, regex na
// tekście z pdf.js), a TA funkcja jest fallbackiem dla dokumentów spoza tych szablonów — do modelu
// idzie więc tylko to, czego appka nie umie przeczytać sama (nowy spedytor, nietypowy układ, skan).
//
// Wzorowane wprost na bochanw/DAB/supabase/functions/parse-order-pdf (appka floty tego samego
// klienta) — TEN SAM kontrakt "nic nie zapisuje się samo": funkcja tylko wypełnia formularz do
// przejrzenia i zatwierdzenia przez dyspozytora, nigdy nie pisze bezpośrednio do `loads`. Pomyłka
// modelu ma więc ograniczony koszt — błędne pole rzuca się w oczy w podglądzie przed zapisem.
//
// RÓŻNICA od DAB: appka DAB wycina tekst z PDF-a po stronie klienta (pdf.js) i wysyła sam tekst
// (albo, dla skanów bez warstwy tekstowej, wyrenderowaną stronę jako JPEG). Ta appka wysyła PDF
// WPROST jako dokument (base64) — natywne wsparcie PDF w Anthropic Messages API obsługuje też
// skany/zdjęcia bez ekstrakcji tekstu po stronie klienta, więc nie potrzeba osobnej ścieżki
// tekst/obraz ani biblioteki do renderowania stron w przeglądarce.
//
// Wymaga sekretu ANTHROPIC_API_KEY w projekcie Supabase Grabowskiego (Project Settings -> Edge
// Functions -> Secrets) — bez klucza funkcja zwraca jawny błąd "not_configured" (status 200, nie
// 500 — appka po stronie klienta ma dostać czytelny komunikat, nie generyczny błąd sieci).
//
// Autoryzacja: domyślna weryfikacja JWT Supabase (verify_jwt) — dostępne dla KAŻDEGO zalogowanego
// konta tego projektu, bez podziału manager/pracownik. Świadomie inaczej niż DAB (tam ta sama
// funkcja jest zawężona do managera przez is_manager(), bo tamten moduł jest z założenia
// finansowy/manager-only) — appka ładunków ma z założenia służyć WSZYSTKIM dyspozytorom naraz
// (patrz CLAUDE.md, "Współpraca kilku dyspozytorów naraz jest GŁÓWNYM celem appki"), a ta appka
// na razie w ogóle nie ma podziału ról. Jeśli w przyszłości pojawi się potrzeba kontroli kosztów
// (limit wywołań/osobę, tylko-manager), to osobna decyzja do podjęcia z właścicielem — NIE
// kopiować tu ograniczenia z DAB bez potwierdzenia, że pasuje do tej appki.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Haiku 4.5 — ten sam wybór co DAB, ten sam powód: to zadanie strukturalnej ekstrakcji, nie
// kreatywne rozumowanie, a appka wywołuje ją za każdym wgranym PDF-em. Natywne wsparcie PDF w
// Anthropic Messages API działa też z Haiku. Jeśli w praktyce zeskanowane/odręczne zlecenia jakiegoś
// klienta wypadną słabo, przełącz na 'claude-sonnet-5' — sam koszt na zlecenie nadal jest niewielki
// wobec wartości zlecenia, ale nie ma sensu płacić więcej, zanim się okaże, że trzeba.
const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';
// Zabezpieczenie przed patologicznie dużym plikiem (np. zeskanowany cały segregator wgrany przez
// pomyłkę zamiast jednego zlecenia) — pojedyncze zlecenie spedycyjne to zwykle 1-3 strony.
const MAX_PDF_BYTES = 8 * 1024 * 1024;

const EXTRACT_TOOL = {
  name: 'extract_order',
  description: 'Zapisuje pola zlecenia spedycyjnego / listu przewozowego (transport kontenerowy) wyciągnięte z dokumentu.',
  input_schema: {
    type: 'object',
    properties: {
      order_number: { type: 'string', description: 'Numer/oznaczenie zlecenia (np. "ZD/1797/6/2026"). Pusty string, jeśli nie występuje w dokumencie.' },
      forwarder: { type: 'string', description: 'Nazwa firmy ZLECENIODAWCY (spedytor zlecający transport — NIE firma wykonująca transport, czyli NIE Grabowski Mariusz Sp. z o.o., nawet jeśli to ona jest adresatem dokumentu). Pusty string, jeśli nieznana.' },
      forwarder_nip: { type: 'string', description: 'NIP/VAT-ID ZLECENIODAWCY (same cyfry, ewentualnie z prefiksem kraju) — z nagłówka/stopki dokumentu. Pusty string, jeśli nie ma. NIE podawaj NIP-u firmy Grabowski.' },
      forwarder_address: { type: 'string', description: 'Ulica i numer w adresie ZLECENIODAWCY, bez kodu pocztowego i miasta. Pusty string, jeśli nie ma.' },
      forwarder_postal_code: { type: 'string', description: 'Kod pocztowy ZLECENIODAWCY (np. "81-537"). Pusty string, jeśli nie ma.' },
      forwarder_city: { type: 'string', description: 'Miejscowość ZLECENIODAWCY. Pusty string, jeśli nie ma.' },
      direction: { type: 'string', enum: ['', 'I', 'E'], description: '"I" jeśli dokument wprost mówi "Import", "E" jeśli "Eksport"/"Export". Pusty string, jeśli dokument tego nie precyzuje — NIE zgaduj kierunku z samej trasy.' },
      container_number: { type: 'string', description: 'Numer kontenera (format ISO 6346, np. "NYKU9911861"). Pusty string, jeśli nie ma.' },
      container_size: { type: 'string', description: 'Wielkość/typ kontenera (np. "20DV", "40HC") — bez nazwy armatora/linii. Pusty string, jeśli nieznana.' },
      shipping_line: { type: 'string', description: 'Linia żeglugowa/armator/gestia kontenera (np. "ONE", "MSC", "Maersk"), jeśli podana. Pusty string, jeśli nie ma.' },
      company_name: { type: 'string', description: 'Nazwa firmy/miejsca załadunku lub rozładunku (np. nazwa magazynu/odbiorcy), jeśli podana osobno od samego adresu. Pusty string, jeśli nie ma.' },
      address: { type: 'string', description: 'Pełny adres (ulica, numer, kod pocztowy, miasto) miejsca załadunku lub rozładunku. Pusty string, jeśli nieznany.' },
      city: { type: 'string', description: 'Sama nazwa miejscowości załadunku/rozładunku, bez reszty adresu. Pusty string, jeśli nieznana.' },
      load_date: { type: 'string', description: 'Data ZAŁADUNKU/podjęcia w formacie RRRR-MM-DD, TYLKO jeśli dokument podaje ją osobno od daty rozładunku. Pusty string, jeśli nieznana — NIGDY nie zgaduj roku ani dnia.' },
      delivery_date: { type: 'string', description: 'Data ROZŁADUNKU/dostawy w formacie RRRR-MM-DD. Pusty string, jeśli nieznana — NIGDY nie zgaduj.' },
      delivery_time: { type: 'string', description: 'Godzina rozładunku/dostawy w formacie GG:MM (24-godzinnym). Pusty string, jeśli nieznana.' },
      customs_location_or_status: { type: 'string', description: 'Miejsce odprawy celnej (nazwa i adres agencji celnej) ALBO status odprawy — cokolwiek dokument faktycznie podaje, dosłownie. Pusty string, jeśli nic nie podano.' },
      rate_amount: { type: ['number', 'null'], description: 'Kwota stawki/frachtu za zlecenie — sama liczba (kropka jako separator dziesiętny, bez waluty, bez separatorów tysięcy). Null, jeśli nieznana.' },
      rate_currency: { type: 'string', description: 'Waluta stawki, np. "PLN" albo "EUR" — tylko do weryfikacji przez dyspozytora, appka dziś zakłada PLN. Pusty string, jeśli nieznana.' },
      payment_terms_days: { type: ['number', 'null'], description: 'Liczba dni terminu płatności (np. z "60 dni od..." -> 60). Null, jeśli nieznana.' },
      payment_terms_note: { type: 'string', description: 'Od jakiego zdarzenia liczony jest termin płatności (np. "od daty wpływu faktury i listu przewozowego"). Pusty string, jeśli nie podano albo nie ma osobnego terminu dni.' },
      notes: { type: 'string', description: 'Inne istotne informacje z dokumentu, których nie da się przypisać do pól wyżej (np. nietypowe wymagania, ważenie, kary umowne warte uwagi). Pusty string, jeśli nic takiego nie ma.' },
      // Poniższe pola pochodzą zwykle z DRUGIEGO dokumentu tego samego zlecenia — listu
      // przewozowego dla kierowcy. Jeden wgrany plik wypełni tylko część z nich; appka skleja
      // dokumenty po stronie klienta (mergeParsedOrders), więc pusty string tu niczego nie psuje.
      pickup_type: { type: 'string', description: 'Miejsce PODJĘCIA kontenera (terminal), dosłownie jak w dokumencie (np. "GCT Gdynia", "BCT", "Baltic Hub") — appka sama sprowadzi to do kodu terminala. Pusty string, jeśli nie podano.' },
      pin_booking: { type: 'string', description: 'Numer PIN / numer wizyty / booking do awizacji na terminalu. Pusty string, jeśli nie ma.' },
      goods_name: { type: 'string', description: 'Nazwa przewożonego towaru. Pusty string, jeśli nie podano.' },
      net_weight_kg: { type: ['number', 'null'], description: 'Waga samego TOWARU w kilogramach (na listach przewozowych bywa podpisana "waga towaru brutto" — chodzi o towar BEZ tary kontenera; appka sama doliczy tarę). Sama liczba w kg. Null, jeśli nieznana.' },
      submitted_where: { type: 'string', description: 'Miejsce złożenia/zdania pustego kontenera po rozładunku (depot/terminal). Pusty string, jeśli nie podano.' },
      driver_name: { type: 'string', description: 'Imię i nazwisko kierowcy. Pusty string, jeśli nie podano.' },
      driver_id_number: { type: 'string', description: 'Numer dowodu osobistego/paszportu kierowcy. Pusty string, jeśli nie podano.' },
      vehicle_plate: { type: 'string', description: 'Numer rejestracyjny CIĄGNIKA/pojazdu. Pusty string, jeśli nie podano.' },
      trailer_plate: { type: 'string', description: 'Numer rejestracyjny NACZEPY/przyczepy. Pusty string, jeśli nie podano.' },
      driver_phone: { type: 'string', description: 'Telefon kierowcy. Pusty string, jeśli nie podano.' },
    },
    required: ['order_number', 'forwarder', 'forwarder_nip', 'forwarder_address', 'forwarder_postal_code', 'forwarder_city', 'direction', 'container_number', 'container_size', 'shipping_line', 'company_name', 'address', 'city', 'load_date', 'delivery_date', 'delivery_time', 'customs_location_or_status', 'rate_amount', 'rate_currency', 'payment_terms_days', 'payment_terms_note', 'notes', 'pickup_type', 'pin_booking', 'goods_name', 'net_weight_kg', 'submitted_where', 'driver_name', 'driver_id_number', 'vehicle_plate', 'trailer_plate', 'driver_phone'],
  },
};

const SYSTEM_PROMPT = `Jesteś ekstraktorem danych z dokumentów przewozowych (transport kontenerowy, import/eksport morski).
Dostajesz plik PDF — zlecenie spedycyjne ALBO list przewozowy dla kierowcy do tego samego zlecenia
(dane kierowcy, pojazdu, terminala podjęcia, towaru). Dokument może być w języku polskim,
niemieckim albo angielskim, w DOWOLNYM układzie (różni spedytorzy formatują to inaczej). Twoje
jedyne zadanie to wywołać narzędzie extract_order z polami, które FAKTYCZNIE znajdziesz w tym
dokumencie — pola z drugiego dokumentu zostaw puste, appka sklei oba po swojej stronie.

Zasady, których nie wolno złamać:
1. NIGDY nie zgaduj ani nie wymyślaj wartości. Jeśli pola nie ma w dokumencie albo nie jesteś
   pewien — zwróć pusty string / null dla tego pola, zgodnie ze schematem. Fałszywie wypełnione
   pole jest gorsze niż puste — dyspozytor i tak zweryfikuje wynik przed zapisem, ale puste pole
   rzuca się w oczy, a błędne bywa przeoczone.
2. Pole "forwarder" (zleceniodawca) to firma, która ZLECA transport Grabowski Mariusz Sp. z o.o.
   — czyli firma wystawiająca dokument, NIE sama firma Grabowski (ona jest zawsze zleceniobiorcą/
   przewoźnikiem wykonującym transport w tych dokumentach, nigdy zleceniodawcą).
3. Rozróżnij "Import"/"Export" WYŁĄCZNIE jeśli dokument to wprost nazywa (nagłówek, etykieta) —
   nie zgaduj kierunku z samej trasy geograficznej.
4. Data w polach load_date/delivery_date MUSI być w formacie RRRR-MM-DD. Jeśli w dokumencie jest
   sama data bez jednoznacznego roku, zostaw pole puste zamiast zgadywać.
5. rate_amount i payment_terms_days to same liczby, bez jednostek/tekstu/waluty.
6. Jeśli dokument wymienia więcej niż jedno miejsce rozładunku, wybierz PIERWSZE — dyspozytor
   doda pozostałe ręcznie, jeśli będzie trzeba (appka dziś obsługuje jedno miejsce na rekord).
7. Kierowca, numery rejestracyjne i telefon to dane z listu przewozowego — jeśli dokument ich nie
   zawiera, zostaw puste. NIE przepisuj tu danych firmy przewozowej ani osoby kontaktowej
   spedytora, tylko faktycznego kierowcę i jego pojazd.
8. net_weight_kg to waga TOWARU w kilogramach. Jeśli dokument podaje wagę w tonach, przelicz na
   kilogramy. Nie dodawaj tary kontenera — appka dolicza ją sama.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, reason: 'method', error: 'Dozwolona jest wyłącznie metoda POST.' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, reason: 'unauthorized', error: 'Brak nagłówka Authorization.' }, 401);

  let body: { pdfBase64?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: 'bad_request', error: 'Nieprawidłowe zapytanie.' }, 400);
  }
  const pdfBase64 = (body.pdfBase64 || '').toString().trim();
  if (!pdfBase64) return json({ ok: false, reason: 'empty', error: 'Brak pliku PDF do analizy.' }, 400);
  // Rozmiar base64 to ~4/3 rozmiaru oryginału — przybliżony, ale wystarczający do odcięcia
  // patologicznych przypadków przed wysłaniem czegokolwiek do modelu.
  if (pdfBase64.length > (MAX_PDF_BYTES * 4) / 3) {
    return json({ ok: false, reason: 'too_large', error: 'Plik PDF jest za duży (limit 8 MB).' }, 400);
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json({ ok: false, reason: 'not_configured', error: 'Brak skonfigurowanego klucza ANTHROPIC_API_KEY w tym projekcie Supabase.' }, 200);
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'extract_order' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: 'Dokument przewozowy w załączonym PDF-ie (zlecenie spedycyjne albo list przewozowy) — wyciągnij pola.' },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json({ ok: false, reason: 'api_error', error: `Model odpowiedział błędem (HTTP ${res.status}). ${detail.slice(0, 300)}` }, 200);
    }
    const data = await res.json();
    const toolUse = (data?.content || []).find((b: { type?: string; name?: string }) => b.type === 'tool_use' && b.name === 'extract_order');
    if (!toolUse || !toolUse.input) {
      return json({ ok: false, reason: 'no_result', error: 'Model nie zwrócił rozpoznanych pól.' }, 200);
    }
    return json({ ok: true, parsed: toolUse.input });
  } catch (e) {
    return json({ ok: false, reason: 'network', error: 'Nie udało się połączyć z API modelu: ' + (e as Error).message }, 200);
  }
});
