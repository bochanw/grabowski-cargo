// ============================================================
// bhub-status — przyjmuje od ROZSZERZENIA DO CHROME odczyty statusów z Baltic Hub i zapisuje je
// przy zleceniach. Sama nigdzie nie wchodzi.
//
// DLACZEGO TAK, a nie jak wcześniej (funkcja sama pobierała stronę):
// baltichub.com stoi za Cloudflare i ma reCAPTCHĘ na formularzu. Zmierzone na produkcji: zwykły
// fetch z serwerowni dostaje 403 (`cf-mitigated: challenge`) na CAŁEJ domenie, ręcznie składany
// `POST /multi` wraca jako "Page Expired" (Laravel, wygasły token CSRF), a płatna zdalna
// przeglądarka przechodziła Cloudflare tylko czasem — ostatni przebieg utknął na "Just a moment...".
// Właściciel zdecydował wprost: dopóki nie ma API terminala, odpytujemy z PRZEGLĄDARKI DYSPOZYTORA.
// To jest też jedyna droga, która przenosi się na kolejne terminale — one też będą się bronić,
// a API na pewno nie będzie u każdego.
//
// PODZIAŁ PRACY (tu jest cała różnica):
//   rozszerzenie  — otwiera stronę terminala w prawdziwej przeglądarce, wpisuje numery, klika,
//                   czyta widoczny tekst. Cloudflare i reCAPTCHA widzą zwykłego człowieka.
//   ta funkcja    — mówi, o które kontenery pytać (`pending`), rozumie odpowiedź (`parse.ts`)
//                   i zapisuje ją przez RPC `apply_bhub_check` jako `bot:baltichub` (`report`),
//                   oraz pilnuje, żeby martwy odczyt było WIDAĆ (`heartbeat`).
//
// Odczyt zapisuje się BEZ zatwierdzania przez dyspozytora — inaczej niż propozycje z maila.
// To świadoma różnica: to nie jest propozycja zmiany zlecenia, tylko cudzy stan (status i waga),
// którego źródłem prawdy jest terminal, a nie my.
//
// Okno godzinowe (dni robocze 6-18) obowiązuje wyłącznie przebieg cykliczny i pilnuje go TA
// funkcja, nie rozszerzenie: reguła ma jedno miejsce, a rozszerzenie nie musi znać polskich świąt.
// ============================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.58.0";
import { parseContainerPage } from "./parse.ts";
import { isWithinPollingWindow, shouldTrackLoad } from "./shared/schedule.ts";
import { isoToOrderSize } from "./shared/isoType.ts";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Dozwolona jest wyłącznie metoda POST." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, reason: "not_configured", error: "Brak SUPABASE_URL/SERVICE_ROLE_KEY w środowisku funkcji." }, 500);
  }

  const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Jedyna droga wejścia: zalogowany człowiek albo rozszerzenie zalogowane na jego konto.
  // Sekretu dla crona już nie ma — nic nie chodzi po stronie serwera, więc nie ma co wpuszczać.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = token ? await admin.auth.getUser(token) : { data: null };
  const userId = userData?.user?.id ?? null;
  if (!userId) {
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
  };
  const action = text(body.action) || "pending";
  const agent = body.agent;

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
        .eq("pickup_type", "BHub")
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
      .filter((load) => (requestedIds ? Boolean((load.container_number ?? "").trim()) : shouldTrackLoad(load)))
      .map((load) => ({ loadId: load.id, container: (load.container_number ?? "").trim().toUpperCase() }));

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

      const details = { ...detailsOf(item.details), _container: container, _zrodlo: "rozszerzenie" };

      // Rozszerzeniu nie udało się nawet dojść do wyników (Cloudflare, zagadka, brak pola).
      // Zapisujemy to przy KAŻDYM zleceniu z paczki — inaczej zlecenie zostaje bez sprawdzenia
      // i bez śladu, a to najgorszy możliwy wynik: wygląda jak sprawdzone.
      const reported = text(item.error);
      if (reported) {
        problems.push(`${container}: ${reported}`);
        await admin.rpc("apply_bhub_check", { p_load_id: loadId, p_error: reported.slice(0, 2000), p_details: details });
        continue;
      }

      const pageText = text(item.text);
      if (!pageText.trim()) {
        const message = `Rozszerzenie nie przysłało treści strony dla ${container}.`;
        problems.push(message);
        await admin.rpc("apply_bhub_check", { p_load_id: loadId, p_error: message, p_details: details });
        continue;
      }

      const parsed = parseContainerPage(pageText, container);
      const fullDetails = { ...parsed.details, ...details, _dlugosc_odpowiedzi: String(pageText.length) };

      if (parsed.notFound) {
        await admin.rpc("apply_bhub_check", {
          p_load_id: loadId,
          p_error: `Baltic Hub nie zna kontenera ${container}.`,
          p_parsed: true,
          p_details: fullDetails,
        });
        continue;
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
          p_error: `Baltic Hub nie zna kontenera ${container}.`,
          p_parsed: true,
          p_details: fullDetails,
        });
        continue;
      }

      if (!parsed.recognised) {
        // Odpowiedź przyszła, ale nie umiemy jej odczytać. To NIE jest "kontener bez danych" —
        // zapisujemy powód i migawkę, a dotychczasowe wartości przy zleceniu zostają nietknięte.
        const message =
          parsed.reason ??
          `Nie rozpoznałem odpowiedzi Baltic Hub dla ${container} (${pageText.length} znaków). Migawka zapisana do diagnozy.`;
        problems.push(message);
        await admin.rpc("apply_bhub_check", { p_load_id: loadId, p_error: message, p_details: fullDetails });
        continue;
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
        p_error: null,
        p_parsed: true,
        p_details: fullDetails,
      });
      if (rpcError) problems.push(`${container}: zapis — ${rpcError.message}`);
      else updated += 1;
    }

    await touchAgent(admin, agent, userId, {
      last_error: problems.length ? problems[0].slice(0, 500) : null,
      ...(updated > 0 ? { last_ok_at: new Date().toISOString() } : {}),
    });

    return json({ ok: true, updated, problems: problems.slice(0, 10) });
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
