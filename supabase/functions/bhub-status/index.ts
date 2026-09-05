// ============================================================
// bhub-status — statusy kontenerów z terminali: zapisuje odczyty przy zleceniach, a dla terminali
// PUBLICZNYCH pobiera je także sama.
//
// DWIE DROGI, podział ustalony z właścicielem („BHub i strony wymagające logowania — wtyczka;
// strony publiczne bez logowania — natywna obsługa, z wtyczką jako zabezpieczeniem"):
//
//   ROZSZERZENIE DO CHROME — Baltic Hub i wszystko, co się broni albo wymaga logowania.
//     baltichub.com stoi za Cloudflare i ma reCAPTCHĘ: zwykły fetch z serwerowni dostaje 403
//     (`cf-mitigated: challenge`) na CAŁEJ domenie, ręcznie składany `POST /multi` wraca jako
//     "Page Expired" (wygasły token CSRF), a płatna zdalna przeglądarka przechodziła Cloudflare
//     tylko czasem. Prawdziwa przeglądarka dyspozytora przechodzi to sama.
//
//   TA FUNKCJA (`cykl`) — BCT i GCT. Publiczne formularze bez logowania i bez captchy; token
//     antyfałszerski biorą z wcześniej pobranej strony, co przy działającym GET-cie jest
//     formalnością (patrz `serwer.ts`). Chodzą z crona co 15 minut, więc statusy odświeżają się,
//     choćby nikt nie miał włączonego komputera.
//
// KTÓRY TERMINAL KTÓRĄ DROGĄ — decyduje TABELA `terminal_sources` (migracja 0033), nie kod.
// To jest owo zabezpieczenie: gdy BCT albo GCT zacznie się bronić, przestawienie jednego wiersza
// oddaje go z powrotem rozszerzeniu — bez wdrożenia i bez aktualizacji wtyczki u dyspozytorów.
// Rozszerzenie nie traci żadnej umiejętności, tylko w normalnym cyklu nie dostaje tych terminali,
// które obsługuje serwer.
//
// Wspólne dla obu dróg: odpowiedź terminala rozumie JEDEN `parse.ts` (transport normalizuje
// `htmlText.ts`), zapis idzie jednym RPC `apply_bhub_check`, a martwy odczyt widać w appce.
//
// Odczyt zapisuje się BEZ zatwierdzania przez dyspozytora — inaczej niż propozycje z maila.
// To świadoma różnica: to nie jest propozycja zmiany zlecenia, tylko cudzy stan (status i waga),
// którego źródłem prawdy jest terminal, a nie my.
//
// Okno godzinowe (dni robocze 6-18) obowiązuje wyłącznie przebieg cykliczny i pilnuje go TA
// funkcja, nie rozszerzenie: reguła ma jedno miejsce, a rozszerzenie nie musi znać polskich świąt.
// ============================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.58.0";
import { parseTerminalPage } from "./parse.ts";
import { isTerminalPickup, isWithinPollingWindow, shouldTrackLoad } from "./shared/schedule.ts";
import { isoToOrderSize } from "./shared/isoType.ts";
import { obslugiwanyZSerwera, paczki, pobierzZTerminala } from "./serwer.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Ile kontenerów oddajemy rozszerzeniu na jeden przebieg. Formularz terminala przyjmuje wiele
// numerów naraz (w wersji testowej do dziesięciu), a rozszerzenie dzieli listę na paczki samo.
// Kolejność "najdawniej sprawdzane pierwsze" (indeks `loads_bhub_pending_idx`) sprawia, że nadmiar
// dojdzie w kolejnym przebiegu, a nie zostanie pominięty na stałe.
const MAX_CONTAINERS_PER_RUN = 30;

// Kontener sprawdzony niedawno nie wraca na listę przez tyle minut.
//
// PO CO: rozszerzenie stoi u KILKU dyspozytorów naraz i każde chodzi swoim kwadransem. Bez tego
// progu dwie włączone przeglądarki pytałyby terminal o te same numery kilka minut po sobie —
// podwójny ruch u kogoś, kto i tak broni się przed automatami, za zero nowej informacji.
// Próg jest krótszy niż odstęp odpytywania (15 min), więc NIE opóźnia normalnego cyklu: pomija
// wyłącznie powtórkę tuż po cudzym sprawdzeniu.
//
// Nie dotyczy pytania o KONKRETNE zlecenia („Sprawdź teraz", zapis zlecenia) — człowiek, który
// pyta, ma dostać odpowiedź, a nie ciszę dlatego, że kolega sprawdzał minutę wcześniej.
const SWIEZOSC_MINUT = 10;

// Ile czasu wolno zająć jednemu przebiegowi serwerowemu, zanim zostawi resztę na kolejny kwadrans.
// Funkcje brzegowe mają twardy limit życia, a przebieg urwany w połowie zostawia zlecenia bez
// sprawdzenia I BEZ ŚLADU — ta sama pułapka, która zjadła dwa zlecenia przy poprzednim podejściu
// do Baltic Huba. Kolejność „najdawniej sprawdzane pierwsze" gwarantuje, że nic nie wypadnie na
// stałe: to, co dziś nie zdążyło, jutro stoi pierwsze w kolejce.
const BUDZET_PRZEBIEGU_MS = 60_000;

// Przebieg serwerowy melduje się w `bhub_agent_state` jak każde rozszerzenie — dzięki temu pasek
// Zestawienia pokazuje martwy odczyt niezależnie od tego, która droga zamilkła.
const AGENT_SERWER = { id: "serwer", label: "Serwer (BCT/GCT, co 15 min)" };

interface LoadRow {
  id: string;
  container_number: string | null;
  pickup_type: string | null;
  bhub_status: string | null;
}

interface Agent {
  id?: unknown;
  label?: unknown;
}

interface ReportItem {
  loadId?: unknown;
  container?: unknown;
  text?: unknown;
  error?: unknown;
  details?: unknown;
  /** Który terminal odpowiedział (BHub / BCT / GCT) — decyduje o wyborze parsera. */
  terminal?: unknown;
  /** O ilu kontenerów pytano w tym samym zapytaniu — rozstrzyga znaczenie zdania „Brak wyników". */
  batchSize?: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Migawka z rozszerzenia bywa dowolna — do bazy wpuszczamy wyłącznie pary tekst→tekst. */
function detailsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k !== "string") continue;
    out[k.slice(0, 80)] = (typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, 20_000);
  }
  return out;
}

/**
 * Ślad po agencie (rozszerzeniu), żeby martwy odczyt było widać w appce. Bez tego statusy po
 * prostu przestałyby się odświeżać w ciszy — a dyspozytor patrzyłby na wczorajszy stan
 * przekonany, że jest dzisiejszy.
 */
async function touchAgent(
  admin: SupabaseClient,
  agent: Agent | undefined,
  userId: string | null,
  patch: Record<string, unknown>,
): Promise<void> {
  const id = text(agent?.id).slice(0, 64);
  if (!id) return;
  await admin
    .from("bhub_agent_state")
    .upsert(
      {
        agent_id: id,
        label: text(agent?.label).slice(0, 120) || null,
        user_id: userId,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...patch,
      },
      { onConflict: "agent_id" },
    )
    .then(() => undefined, () => undefined);
}

/** Domyślne drogi, gdy tabeli `terminal_sources` jeszcze nie ma (migracja nie zaaplikowana). */
const DROGI_DOMYSLNE: Record<string, string> = { BHub: "wtyczka", BCT: "serwer", GCT: "serwer" };

/**
 * Którą drogą pytamy każdy terminal. Czytamy z bazy przy KAŻDYM przebiegu, bo to jest przełącznik
 * awaryjny — ma działać w chwili, w której ktoś go przestawi, a nie po następnym wdrożeniu.
 */
async function drogiTerminali(admin: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await admin.from("terminal_sources").select("terminal, mode");
  if (error || !data) return { ...DROGI_DOMYSLNE };
  const drogi = { ...DROGI_DOMYSLNE };
  for (const wiersz of data as { terminal: string; mode: string }[]) drogi[wiersz.terminal] = wiersz.mode;
  return drogi;
}

interface DoZapisania {
  loadId: string;
  container: string;
  terminal: string;
  /** Treść strony w kształcie `innerText`. Pusta = nie było czego czytać. */
  pageText: string;
  /** Błąd, przez który do treści w ogóle nie doszliśmy. */
  error?: string;
  details: Record<string, string>;
  /** Ile kontenerów było w tym samym zapytaniu — rozstrzyga znaczenie zdania „Brak wyników". */
  batchSize?: number;
}

/**
 * JEDNA droga zapisu odczytu przy zleceniu — wspólna dla rozszerzenia (`report`) i dla przebiegu
 * serwerowego (`cykl`). Rozdzielenie jej na dwie kopie znaczyłoby, że reguły „czego nie wolno
 * nadpisać" i „co znaczy brak wyników" rozjadą się przy pierwszej poprawce.
 *
 * Zwraca opis problemu albo `null`, gdy zapis się udał.
 */
async function zapiszOdczyt(admin: SupabaseClient, dane: DoZapisania): Promise<string | null> {
  const { loadId, container, terminal, pageText, details } = dane;

  // Nie doszliśmy nawet do wyników (Cloudflare, zagadka, brak pola, terminal nie odpowiada).
  // Zapisujemy to PRZY ZLECENIU — inaczej zostaje ono bez sprawdzenia i bez śladu, a to najgorszy
  // możliwy wynik: wygląda jak sprawdzone.
  if (dane.error) {
    await admin.rpc("apply_bhub_check", { p_load_id: loadId, p_error: dane.error.slice(0, 2000), p_details: details });
    return `${container}: ${dane.error}`;
  }

  if (!pageText.trim()) {
    const message = `Nie było treści strony dla ${container}.`;
    await admin.rpc("apply_bhub_check", { p_load_id: loadId, p_error: message, p_details: details });
    return message;
  }

  const parsed = parseTerminalPage(pageText, container, terminal);
  const fullDetails = { ...parsed.details, ...details, _dlugosc_odpowiedzi: String(pageText.length) };

  if (parsed.notFound) {
    await admin.rpc("apply_bhub_check", {
      p_load_id: loadId,
      p_error: `${terminal} nie zna kontenera ${container}.`,
      p_parsed: true,
      p_details: fullDetails,
      p_terminal: terminal,
    });
    return null;
  }

  // Terminal odpowiada „Brak wyników:" BEZ wymienienia numerów (zmierzone na produkcji:
  // pytanie o pięć kontenerów w trybie „wiele" wróciło dokładnie tak). Traktujemy to jako
  // „nie zna żadnego z zapytanych" TYLKO wtedy, gdy w odpowiedzi nie ma ANI JEDNEJ karty —
  // przy odpowiedzi mieszanej (część kart, część nieznanych) numery są wymienione po
  // dwukropku i czyta je `brakWynikowDla`, więc tu nie wolno zgadywać.
  const brakJakichkolwiekKart = !/Karta kontenera/i.test(pageText);
  const mowiBrakWynikow = /brak wynik|no results|not found/i.test(pageText);
  if (!parsed.recognised && brakJakichkolwiekKart && mowiBrakWynikow) {
    await admin.rpc("apply_bhub_check", {
      p_load_id: loadId,
      p_error: `${terminal} nie zna kontenera ${container}.`,
      p_parsed: true,
      p_details: fullDetails,
      p_terminal: terminal,
    });
    return null;
  }

  if (!parsed.recognised) {
    // Odpowiedź przyszła, ale nie umiemy jej odczytać. To NIE jest "kontener bez danych" —
    // zapisujemy powód i migawkę, a dotychczasowe wartości przy zleceniu zostają nietknięte.
    const message =
      parsed.reason ??
      `Nie rozpoznałem odpowiedzi ${terminal} dla ${container} (${pageText.length} znaków). Migawka zapisana do diagnozy.`;
    await admin.rpc("apply_bhub_check", { p_load_id: loadId, p_error: message, p_details: fullDetails });
    return message;
  }

  const { error: rpcError } = await admin.rpc("apply_bhub_check", {
    p_load_id: loadId,
    p_status: parsed.status,
    p_status_raw: parsed.statusRaw,
    p_iso_type: parsed.isoType,
    p_shipping_line: parsed.shippingLine,
    p_gross_weight_kg: parsed.grossWeightKg,
    // Kod ISO terminala w zapisie klienta ("22G1" → "20 DV"). RPC wpisze to WYŁĄCZNIE w puste
    // pole „Wielkość" — przy rozbieżności appka i tak alarmuje w kolumnie statusu, a cicha
    // podmiana tego, co wpisał dyspozytor albo dokument, byłaby gorsza niż widoczna sprzeczność.
    p_container_size: isoToOrderSize(parsed.isoType),
    // Trzy rubryki, o które poprosił właściciel (migracja 0031). `p_time_out` niesie PUSTY
    // TEKST, gdy rubryka jest pusta — to informacja „kontener stoi", nie brak informacji.
    p_net_weight_kg: parsed.netWeightKg,
    p_commodity_weight_kg: parsed.commodityWeightKg,
    p_time_out: parsed.timeOut,
    p_terminal: terminal,
    p_error: null,
    p_parsed: true,
    p_details: fullDetails,
  });
  return rpcError ? `${container}: zapis — ${rpcError.message}` : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Dozwolona jest wyłącznie metoda POST." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, reason: "not_configured", error: "Brak SUPABASE_URL/SERVICE_ROLE_KEY w środowisku funkcji." }, 500);
  }

  const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // DWIE drogi wejścia:
  //   1. zalogowany człowiek (albo rozszerzenie zalogowane na jego konto) — wszystkie działania,
  //   2. cron, sekretem `x-ingest-secret` — wyłącznie przebieg cykliczny `cykl`.
  // Sekret jest TEN SAM co przy skrzynce mailowej i celowo: jest już wpisany w Vault i w sekretach
  // Edge Functions, więc odczyt rusza od razu, zamiast czekać, aż właściciel wklei nowy.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = token ? await admin.auth.getUser(token) : { data: null };
  const userId = userData?.user?.id ?? null;

  const sekret = Deno.env.get("INGEST_SECRET") ?? "";
  const zCrona = Boolean(sekret) && (req.headers.get("x-ingest-secret") ?? "") === sekret;

  if (!userId && !zCrona) {
    return json({ ok: false, reason: "unauthorized", error: "Brak uprawnień do sprawdzania statusów." }, 401);
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    loadIds?: unknown;
    limit?: unknown;
    agent?: Agent;
    results?: unknown;
    error?: unknown;
    checked?: unknown;
    /** `probe`: który terminal i jaki numer podejrzeć bez zapisu. */
    terminal?: unknown;
    container?: unknown;
  };
  const action = text(body.action) || "pending";
  const agent = body.agent;

  // Cron ma prawo TYLKO do przebiegu cyklicznego. Nie dlatego, że reszta byłaby groźna, tylko
  // dlatego, że sekret w Vaulcie nie jest niczyim kontem — a `report` zapisuje przy zleceniach.
  if (!userId && action !== "cykl") {
    return json({ ok: false, reason: "unauthorized", error: `Sekret crona uprawnia wyłącznie do „cykl", nie do „${action}".` }, 403);
  }

  // ---------------------------------------------------------------- pending
  // "O co mam zapytać terminal?" — lista numerów dla rozszerzenia.
  if (action === "pending") {
    const requestedIds = Array.isArray(body.loadIds)
      ? (body.loadIds as unknown[]).filter((id): id is string => typeof id === "string")
      : null;

    // Okno godzinowe obowiązuje TYLKO przebieg cykliczny. Dyspozytor, który poprosi o sprawdzenie
    // konkretnych zleceń o 20:00 albo w sobotę, ma dostać odpowiedź — ograniczenie jest po to, żeby
    // nie odpytywać terminala bez potrzeby, a nie po to, żeby blokować człowieka.
    if (!requestedIds && !isWithinPollingWindow(new Date())) {
      await touchAgent(admin, agent, userId, { last_error: null });
      return json({ ok: true, window: false, items: [], skipped: "poza oknem odpytywania (dni robocze 6-18)" });
    }

    let query = admin
      .from("loads")
      .select("id, container_number, pickup_type, bhub_status")
      .not("container_number", "is", null)
      .order("bhub_checked_at", { ascending: true, nullsFirst: true })
      .limit(typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, MAX_CONTAINERS_PER_RUN) : MAX_CONTAINERS_PER_RUN);

    // Rozszerzenie dostaje WYŁĄCZNIE terminale, które są dziś jego (`terminal_sources`). BCT i GCT
    // pobiera serwer, więc pytanie o nie z przeglądarki byłoby podwójnym ruchem u terminala za
    // zero nowej informacji. Przestawienie wiersza w tabeli oddaje je rozszerzeniu z powrotem.
    const drogi = await drogiTerminali(admin);
    const dlaWtyczki = Object.keys(drogi).filter((t) => drogi[t] !== "serwer");

    if (requestedIds) {
      // CZŁOWIEK PYTA O KONKRETNE ZLECENIA — bez filtrów.
      //
      // Reguły "tylko podjęcie z BHub", "tylko nie-ZP" i "nie częściej niż co 10 minut" są po to,
      // żeby cykl nie zawracał terminalowi głowy bez potrzeby. Wobec kliknięcia dyspozytora nie
      // mają sensu: właściciel wprost — "mają status ZP, więc program ich już nie sprawdza, jak
      // teraz sprawdzić ponownie?". Odpowiedź brzmi: zaznaczyć wiersze i poprosić, a wtedy
      // sprawdzamy je niezależnie od tego, co stoi w kolumnie statusu.
      query = query.in("id", requestedIds);
    } else {
      const swieze = new Date(Date.now() - SWIEZOSC_MINUT * 60_000).toISOString();
      query = query
        // O tym, gdzie pytać, decyduje "Podjęcie" — to samo pole, które dyspozytor już wypełnia
        // (BHub / BCT / GCT; Poimport i Depot to nie terminale). Tu zawężone do terminali, których
        // NIE obsługuje serwer.
        .in("pickup_type", dlaWtyczki)
        // "ZP już nie ruszamy (jest już zwolniony i nie ma to sensu)".
        .or("bhub_status.is.null,bhub_status.neq.ZP")
        .or(`bhub_checked_at.is.null,bhub_checked_at.lt.${swieze}`);
    }

    const { data: rows, error } = await query;
    if (error) return json({ ok: false, reason: "db", error: error.message }, 500);

    // Druga straż po stronie kodu: ta sama reguła co w appce (shared/schedule.ts), żeby zapytanie
    // SQL i kod nie mogły się rozjechać w tym, co znaczy "podlega śledzeniu". Przy pytaniu
    // o konkretne zlecenia straż jest wyłączona — patrz komentarz wyżej.
    const items = ((rows ?? []) as LoadRow[])
      .filter((load) =>
        requestedIds
          ? Boolean((load.container_number ?? "").trim()) && isTerminalPickup(load.pickup_type)
          : shouldTrackLoad(load),
      )
      // Także przy pytaniu o KONKRETNE zlecenia: terminal obsługiwany z serwera nie jest robotą
      // rozszerzenia. Appka woła wtedy `cykl` z tymi samymi zleceniami, a odpowiedź stamtąd mówi
      // wprost, które zlecenia zostały dla wtyczki.
      .filter((load) => dlaWtyczki.includes((load.pickup_type ?? "").trim()))
      .map((load) => ({
        loadId: load.id,
        container: (load.container_number ?? "").trim().toUpperCase(),
        // Rozszerzenie samo nie wie, gdzie pytać — dostaje to razem z numerem. Dzięki temu dołożenie
        // czwartego terminala jest zmianą po stronie serwera, a nie na komputerze każdego dyspozytora.
        terminal: (load.pickup_type ?? "").trim(),
      }));

    await touchAgent(admin, agent, userId, {});
    return json({ ok: true, window: true, items });
  }

  // ---------------------------------------------------------------- report
  // "Oto, co terminal pokazał" — tekst strony na kontener albo błąd całej paczki.
  if (action === "report") {
    const results = Array.isArray(body.results) ? (body.results as ReportItem[]) : [];
    if (results.length === 0) return json({ ok: false, reason: "bad_request", error: "Pusta lista wyników." }, 400);

    let updated = 0;
    const problems: string[] = [];

    for (const item of results) {
      const loadId = text(item.loadId);
      const container = text(item.container).trim().toUpperCase();
      if (!loadId) continue;

      const terminal = text(item.terminal).trim() || "BHub";
      const problem = await zapiszOdczyt(admin, {
        loadId,
        container,
        terminal,
        pageText: text(item.text),
        error: text(item.error) || undefined,
        details: { ...detailsOf(item.details), _container: container, _terminal: terminal, _zrodlo: "rozszerzenie" },
        batchSize: typeof item.batchSize === "number" ? item.batchSize : undefined,
      });
      if (problem) problems.push(problem);
      else updated += 1;
    }

    await touchAgent(admin, agent, userId, {
      last_error: problems.length ? problems[0].slice(0, 500) : null,
      ...(updated > 0 ? { last_ok_at: new Date().toISOString() } : {}),
    });

    return json({ ok: true, updated, problems: problems.slice(0, 10) });
  }

  // ---------------------------------------------------------------- cykl
  // Przebieg SERWEROWY: funkcja sama pobiera strony terminali publicznych (BCT, GCT), czyta je
  // tym samym `parse.ts` co odczyt z rozszerzenia i zapisuje przy zleceniach.
  //
  // Woła to cron co 15 minut (bez tokenu, sekretem) ORAZ appka, gdy dyspozytor prosi o konkretne
  // zlecenia. W odpowiedzi mówimy, których zleceń NIE obsłużyliśmy, żeby appka mogła dla nich
  // poprosić rozszerzenie — appka nie musi znać podziału terminali, zna go tylko serwer.
  if (action === "cykl") {
    const requestedIds = Array.isArray(body.loadIds)
      ? (body.loadIds as unknown[]).filter((id): id is string => typeof id === "string")
      : null;

    const drogi = await drogiTerminali(admin);
    const serwerowe = Object.keys(drogi).filter((t) => drogi[t] === "serwer" && obslugiwanyZSerwera(t));

    // Okno godzinowe obowiązuje tylko cykl automatyczny — człowiek, który pyta o konkretne
    // zlecenia o 20:00, ma dostać odpowiedź (ta sama zasada co w `pending`).
    if (!requestedIds && !isWithinPollingWindow(new Date())) {
      await touchAgent(admin, AGENT_SERWER, null, { last_error: null });
      return json({ ok: true, window: false, updated: 0, obsluzone: [], dlaWtyczki: [], skipped: "poza oknem odpytywania (dni robocze 6-18)" });
    }

    let query = admin
      .from("loads")
      .select("id, container_number, pickup_type, bhub_status")
      .not("container_number", "is", null)
      .order("bhub_checked_at", { ascending: true, nullsFirst: true })
      .limit(MAX_CONTAINERS_PER_RUN);

    if (requestedIds) {
      query = query.in("id", requestedIds);
    } else {
      const swieze = new Date(Date.now() - SWIEZOSC_MINUT * 60_000).toISOString();
      query = query
        .in("pickup_type", serwerowe.length ? serwerowe : ["__zaden__"])
        .or("bhub_status.is.null,bhub_status.neq.ZP")
        .or(`bhub_checked_at.is.null,bhub_checked_at.lt.${swieze}`);
    }

    const { data: rows, error } = await query;
    if (error) return json({ ok: false, reason: "db", error: error.message }, 500);

    const wszystkie = ((rows ?? []) as LoadRow[]).filter((load) =>
      requestedIds
        ? Boolean((load.container_number ?? "").trim()) && isTerminalPickup(load.pickup_type)
        : shouldTrackLoad(load),
    );

    // Zlecenia, których serwer nie obsługuje, ODDAJEMY appce z nazwy — to jest jedyne miejsce,
    // w którym podział terminali jest rozstrzygany, więc appka nie może się z nim rozjechać.
    const dlaWtyczki = wszystkie
      .filter((load) => !serwerowe.includes((load.pickup_type ?? "").trim()))
      .map((load) => load.id);

    const doPobrania = wszystkie.filter((load) => serwerowe.includes((load.pickup_type ?? "").trim()));

    // Grupujemy po terminalu, żeby GCT dostało jedno zapytanie na dziesięć kontenerów.
    const wgTerminala = new Map<string, LoadRow[]>();
    for (const load of doPobrania) {
      const terminal = (load.pickup_type ?? "").trim();
      wgTerminala.set(terminal, [...(wgTerminala.get(terminal) ?? []), load]);
    }

    const start = Date.now();
    const obsluzone: string[] = [];
    const problems: string[] = [];
    let updated = 0;
    let przerwane = 0;

    for (const [terminal, zlecenia] of wgTerminala) {
      // BCT pyta się o jeden kontener naraz, więc token i ciasteczko sesji przechodzą przez całą
      // paczkę zamiast być pobierane od nowa przed każdym numerem (zmierzone: da się).
      const sesja: { token?: string; cookie?: string } = {};
      const numery = zlecenia.map((load) => (load.container_number ?? "").trim().toUpperCase());
      const wgNumeru = new Map(zlecenia.map((load, i) => [numery[i], load]));

      for (const paczka of paczki(terminal, numery)) {
        // Budżet czasu. Reszta zleceń NIE przepada: kolejność „najdawniej sprawdzane pierwsze"
        // sprawia, że w następnym kwadransie stoją pierwsze w kolejce. Urwanie się funkcji
        // w połowie byłoby gorsze — zlecenia zostałyby bez sprawdzenia I BEZ ŚLADU.
        if (Date.now() - start > BUDZET_PRZEBIEGU_MS) {
          przerwane += paczka.length;
          continue;
        }

        const wspolne = { _terminal: terminal, _zrodlo: "serwer", _paczka: paczka.join(", ") };
        try {
          const odpowiedz = await pobierzZTerminala(terminal, paczka, sesja);
          for (const numer of paczka) {
            const load = wgNumeru.get(numer);
            if (!load) continue;
            const problem = await zapiszOdczyt(admin, {
              loadId: load.id,
              container: numer,
              terminal,
              pageText: odpowiedz.tekst,
              details: { ...wspolne, _container: numer, _adres: odpowiedz.adres, _dlugosc_html: String(odpowiedz.dlugoscHtml) },
              batchSize: paczka.length,
            });
            obsluzone.push(load.id);
            if (problem) problems.push(problem);
            else updated += 1;
          }
        } catch (e) {
          // Terminal nie odpowiedział albo zmienił formularz. Zapisujemy to PRZY KAŻDYM zleceniu
          // z paczki — cicha awaria wyglądałaby jak „sprawdzone, nic nowego".
          const powod = e instanceof Error ? e.message : String(e);
          for (const numer of paczka) {
            const load = wgNumeru.get(numer);
            if (!load) continue;
            await zapiszOdczyt(admin, {
              loadId: load.id, container: numer, terminal, pageText: "", error: powod,
              details: { ...wspolne, _container: numer },
            });
            obsluzone.push(load.id);
          }
          problems.push(`${terminal}: ${powod}`);
        }
      }
    }

    // Ślad po przebiegu serwerowym — w tej samej tabeli co rozszerzenia, więc pasek Zestawienia
    // pokazuje martwy odczyt niezależnie od tego, KTÓRA droga zamilkła.
    await touchAgent(admin, AGENT_SERWER, null, {
      last_error: problems.length ? problems[0].slice(0, 500) : null,
      ...(updated > 0 ? { last_ok_at: new Date().toISOString() } : {}),
      checked_count: obsluzone.length,
    });

    return json({
      ok: true,
      window: true,
      updated,
      obsluzone,
      dlaWtyczki,
      ...(przerwane ? { przerwane, uwaga: `${przerwane} kontenerów zostało na kolejny przebieg (budżet czasu).` } : {}),
      problems: problems.slice(0, 10),
    });
  }

  // ---------------------------------------------------------------- probe
  // Podgląd BEZ ZAPISU: pobierz stronę terminala dla jednego numeru i pokaż, co z niej wyszło.
  // Do sprawdzenia, czy terminal w ogóle przyjmuje zapytania z serwerowni — i czy formularz
  // wygląda tak, jak myślimy. Nie dotyka ANI JEDNEGO zlecenia.
  if (action === "probe") {
    const terminal = text(body.terminal).trim();
    const container = text(body.container).trim().toUpperCase();
    if (!obslugiwanyZSerwera(terminal)) {
      return json({ ok: false, reason: "bad_request", error: `Z serwera pytamy tylko BCT i GCT, nie „${terminal}".` }, 400);
    }
    if (!container) return json({ ok: false, reason: "bad_request", error: "Podaj numer kontenera." }, 400);

    try {
      const odpowiedz = await pobierzZTerminala(terminal, [container]);
      const parsed = parseTerminalPage(odpowiedz.tekst, container, terminal);
      return json({
        ok: true,
        adres: odpowiedz.adres,
        dlugoscHtml: odpowiedz.dlugoscHtml,
        dlugoscTekstu: odpowiedz.tekst.length,
        parsed: { ...parsed, details: parsed.details },
        tekst: odpowiedz.tekst.slice(0, 4000),
      });
    } catch (e) {
      return json({ ok: false, reason: "fetch", error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  // ---------------------------------------------------------------- heartbeat
  // "Żyję" po każdym przebiegu — także (a właściwie zwłaszcza) gdy przebieg się nie udał.
  if (action === "heartbeat") {
    const err = text(body.error).slice(0, 500);
    await touchAgent(admin, agent, userId, {
      last_error: err || null,
      ...(err ? {} : { last_ok_at: new Date().toISOString() }),
      ...(typeof body.checked === "number" ? { checked_count: body.checked } : {}),
    });
    return json({ ok: true });
  }

  return json({ ok: false, reason: "bad_request", error: `Nieznane działanie: ${action}.` }, 400);
});
