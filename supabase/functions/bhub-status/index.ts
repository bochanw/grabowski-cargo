// ============================================================
// bhub-status — sprawdza w Baltic Hub status kontenerów, które podejmujemy z BHub, i zapisuje
// wynik przy zleceniu. Odpalane cyklicznie przez pg_cron (co 15 minut, dni robocze 6-18) oraz
// z przeglądarki: zaraz po zapisaniu zlecenia i z guzika „Statusy BHub".
//
// Właściciel: "Po wgraniu zlecenia które pobieramy z BHub program wchodzi na stronę i sprawdza
// status. Sprawdzając kontener po raz pierwszy pobierzemy wagę brutto kontenera (ta jest nadrzędna
// i nadpisuje dowolne wartości ze zleceń). Odpytujemy co 15 minut w dni robocze od 6 do 18. Tylko
// kontenery które nie mają statusu ZP."
//
// INACZEJ NIŻ mail-poll: ta funkcja ZAPISUJE do `loads` sama, bez zatwierdzania przez dyspozytora.
// To świadoma różnica — to nie jest propozycja zmiany zlecenia (którą człowiek ma sprawdzić), tylko
// odczyt cudzego stanu: statusu i wagi, których źródłem prawdy jest terminal, a nie my. Zapis idzie
// przez RPC `apply_bhub_check`, więc trafia do dziennika zmian jako `bot:baltichub` i dotyka
// wyłącznie pól statusu oraz wagi brutto.
//
// TRANSPORT: patrz source.ts — dziś baltichub.com jest za Cloudflare i odrzuca zapytania
// z serwerowni (sprawdzone), więc bez `BHUB_SOURCE=brightdata` i sekretów Bright Data funkcja
// zapisze przy zleceniach czytelny błąd zamiast statusu. To jest zamierzone: martwy odczyt ma być
// WIDAĆ, a nie po cichu nic nie robić.
// ============================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.58.0";
import { containerUrl, createStatusSource } from "./source.ts";
import { parseContainerPage } from "./parse.ts";
import { isWithinPollingWindow, shouldTrackLoad } from "./shared/schedule.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Funkcja brzegowa ma ograniczony czas życia, a cron wróci za 15 minut — lepiej dowieźć 25
// kontenerów w komplecie niż urwać się w połowie stu. Najdawniej sprawdzane idą pierwsze
// (kolejność z indeksu `loads_bhub_pending_idx`), więc nic nie zostaje pominięte na stałe.
const MAX_CONTAINERS_PER_RUN = 25;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

interface LoadRow {
  id: string;
  container_number: string | null;
  pickup_type: string | null;
  bhub_status: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Dozwolona jest wyłącznie metoda POST." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ingestSecret = Deno.env.get("INGEST_SECRET") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, reason: "not_configured", error: "Brak SUPABASE_URL/SERVICE_ROLE_KEY w środowisku funkcji." }, 500);
  }

  const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Dwie drogi wywołania, jak w mail-poll: pg_cron (sekret w nagłówku) albo zalogowany dyspozytor.
  const fromCron = Boolean(ingestSecret) && (req.headers.get("x-ingest-secret") ?? "") === ingestSecret;
  let authorized = fromCron;
  if (!authorized) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (token) {
      const { data } = await admin.auth.getUser(token);
      authorized = Boolean(data?.user);
    }
  }
  if (!authorized) return json({ ok: false, reason: "unauthorized", error: "Brak uprawnień do sprawdzania statusów." }, 401);

  const body = (await req.json().catch(() => ({}))) as { loadIds?: string[]; probeContainer?: string };
  const requestedIds = Array.isArray(body.loadIds) ? body.loadIds.filter((id) => typeof id === "string") : null;

  // Podgląd bez zapisu: pobiera stronę dla podanego kontenera i zwraca, co z niej wyszło.
  // Po to, żeby dało się zobaczyć układ strony i sprawdzić adres w BHUB_CONTAINER_URL, nie
  // dotykając ani jednego zlecenia. Nic nie zapisuje do bazy.
  if (typeof body.probeContainer === "string" && body.probeContainer.trim()) {
    const container = body.probeContainer.trim().toUpperCase();
    const probe = createStatusSource();
    try {
      const html = await probe.fetchContainerPage(container);
      const parsed = parseContainerPage(html, container);
      return json({ ok: true, source: probe.name, url: containerUrl(container), parsed, htmlLength: html.length });
    } catch (e) {
      return json({ ok: false, source: probe.name, url: containerUrl(container), error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Okno godzinowe obowiązuje TYLKO odpytywanie cykliczne. Dyspozytor, który kliknie „Sprawdź
  // teraz" o 20:00 albo w sobotę, ma dostać odpowiedź — ograniczenie jest po to, żeby nie
  // odpytywać terminala bez potrzeby, a nie po to, żeby blokować człowieka.
  if (!requestedIds && !isWithinPollingWindow(new Date())) {
    return json({ ok: true, checked: 0, updated: 0, skipped: "poza oknem odpytywania (dni robocze 6-18)" });
  }

  let query = admin
    .from("loads")
    .select("id, container_number, pickup_type, bhub_status")
    .eq("pickup_type", "BHub")
    .not("container_number", "is", null)
    // "ZP już nie ruszamy (jest już zwolniony i nie ma to sensu)".
    .or("bhub_status.is.null,bhub_status.neq.ZP")
    .order("bhub_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_CONTAINERS_PER_RUN);
  if (requestedIds) query = query.in("id", requestedIds);

  const { data: rows, error } = await query;
  if (error) return json({ ok: false, reason: "db", error: error.message }, 500);

  // Druga straż po stronie kodu: ta sama reguła co w przeglądarce (shared/schedule.ts), żeby zapytanie
  // SQL i appka nie mogły się rozjechać w tym, co znaczy "podlega śledzeniu".
  const targets = ((rows ?? []) as LoadRow[]).filter(shouldTrackLoad);

  const source = createStatusSource();
  let updated = 0;
  const problems: string[] = [];

  for (const load of targets) {
    const container = (load.container_number ?? "").trim().toUpperCase();
    try {
      const html = await source.fetchContainerPage(container);
      const parsed = parseContainerPage(html, container);

      if (parsed.notFound) {
        await admin.rpc("apply_bhub_check", {
          p_load_id: load.id,
          p_error: `Baltic Hub nie zna kontenera ${container}.`,
          p_details: parsed.details,
        });
        continue;
      }

      const { error: rpcError } = await admin.rpc("apply_bhub_check", {
        p_load_id: load.id,
        p_status: parsed.status,
        p_status_raw: parsed.statusRaw,
        p_iso_type: parsed.isoType,
        p_shipping_line: parsed.shippingLine,
        p_gross_weight_kg: parsed.grossWeightKg,
        p_error: null,
        p_details: parsed.details,
      });
      if (rpcError) problems.push(`${container}: zapis — ${rpcError.message}`);
      else updated += 1;
    } catch (e) {
      // Błąd JEDNEGO kontenera nie może przerwać przebiegu — reszta ma zostać sprawdzona.
      // Treść ląduje przy zleceniu (kolumna bhub_error, widoczna w dymku komórki statusu).
      const message = e instanceof Error ? e.message : String(e);
      problems.push(`${container}: ${message}`);
      await admin
        .rpc("apply_bhub_check", { p_load_id: load.id, p_error: message })
        .then(() => undefined, () => undefined);
    }
  }

  return json({
    ok: true,
    source: source.name,
    checked: targets.length,
    updated,
    problems: problems.slice(0, 10),
  });
});
