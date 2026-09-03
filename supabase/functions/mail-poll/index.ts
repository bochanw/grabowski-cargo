// ============================================================
// mail-poll — odczytuje nowe maile ze skrzynki firmowej i wrzuca kandydatów na zlecenia do kolejki
// „Skrzynka" (tabela email_messages). Odpalane cyklicznie przez pg_cron, a także ręcznie
// przyciskiem „Sprawdź teraz" w UI.
//
// ŹRÓDŁO POCZTY jest wymienne (patrz mailSource.ts): Exchange Online przez Microsoft Graph
// (`MAIL_SOURCE=graph`, domyślne) albo serwer IMAP dla Exchange lokalnego (`MAIL_SOURCE=imap`).
// Reszta potoku jest wspólna — różnica między chmurą a serwerem lokalnym kończy się na pobraniu
// wiadomości.
//
// KONTRAKT, ten sam co przy ręcznym imporcie: NIC nie zapisuje się samo do `loads`. Funkcja tworzy
// wyłącznie PROPOZYCJE do zatwierdzenia przez dyspozytora. Pomyłka modelu nie wchodzi więc cicho
// do bazy ani na fakturę.
//
// KOLEJNOŚĆ ODCZYTU (ta sama co w ImportOrderDialog — darmowe i pewne przed płatnym i
// probabilistycznym):
//   1. prefiltr BEZ modelu — czy ten mail w ogóle dotyczy zleceń,
//   2. znany szablon (regex na tekście z pdf.js) — darmowy, deterministyczny,
//   3. Claude (parse-order-pdf) — tylko dla dokumentów spoza szablonów.
// Mail, który nie przejdzie punktu 1, NIE kosztuje ani grosza.
//
// BEZPIECZEŃSTWO: treść maila i załączniki pisze ktokolwiek, kto zna adres skrzynki. Traktujemy je
// jako DANE, nigdy jako polecenia — stąd prefiltr po stronie kodu (nie modelu), limit rozmiaru i
// typu załączników, oraz to, że nic nie trafia do `loads` bez kliknięcia człowieka.
// ============================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.58.0";
import { GraphMailSource } from "./graph.ts";
import { ImapMailSource, requireImapConfig } from "./imapSource.ts";
import { type MailSource, MailSourceError } from "./mailSource.ts";
import { assessRelevance, MIN_ORDER_NUMBER_LENGTH, normalizeOrderNumber } from "./relevance.ts";
import { extractPdfText } from "./pdfText.ts";
import { matchKnownTemplate } from "./shared/orderTemplates.ts";
import { previousWorkingDay } from "./shared/workingDays.ts";
import {
  EMPTY_PARSED_ORDER,
  mergeParsedOrders,
  normalizeParsedOrder,
  type ParsedOrder,
} from "./shared/parsedOrder.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Ile maili maksymalnie na jeden przebieg. Funkcja brzegowa ma ograniczony czas życia, a pg_cron
// i tak wróci za 2 minuty — lepiej dowieźć 15 maili w komplecie niż urwać się w połowie 200.
const MAX_MESSAGES_PER_RUN = 15;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ------------------------------------------------------------
// Odczyt dokumentu: znany szablon → Claude
// ------------------------------------------------------------
async function parseViaClaude(
  supabaseUrl: string,
  serviceKey: string,
  payload: { pdfBase64?: string; text?: string },
): Promise<{ ok: true; parsed: ParsedOrder } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/parse-order-pdf`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { ok: false, error: `nieoczekiwana odpowiedź (HTTP ${res.status})` };
    if (!data.ok) return { ok: false, error: String(data.error ?? data.reason ?? "nieznany błąd") };
    // normalizeParsedOrder sprowadza też nazwy terminali do listy (GCT/BCT/BHub) — patrz shared/parsedOrder.ts.
    return { ok: true, parsed: normalizeParsedOrder(data.parsed) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function buildMailSource(env: (key: string) => string | undefined): MailSource {
  const kind = (env("MAIL_SOURCE") ?? "graph").toLowerCase();
  if (kind === "imap") return new ImapMailSource(requireImapConfig(env));

  const tenantId = env("MS_TENANT_ID") ?? "";
  const clientId = env("MS_CLIENT_ID") ?? "";
  const clientSecret = env("MS_CLIENT_SECRET") ?? "";
  const mailbox = env("MAILBOX_ADDRESS") ?? "";
  if (!tenantId || !clientId || !clientSecret || !mailbox) {
    throw new MailSourceError(
      "Brak sekretów MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MAILBOX_ADDRESS w projekcie Supabase.",
    );
  }
  return new GraphMailSource({ tenantId, clientId, clientSecret, mailbox });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Dozwolona jest wyłącznie metoda POST." }, 405);

  const env = (key: string) => Deno.env.get(key);
  const supabaseUrl = env("SUPABASE_URL") ?? "";
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ingestSecret = env("INGEST_SECRET") ?? "";

  if (!supabaseUrl || !serviceKey) {
    return json({ ok: false, reason: "not_configured", error: "Brak SUPABASE_URL/SERVICE_ROLE_KEY w środowisku funkcji." }, 500);
  }

  const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Dwie drogi wywołania: pg_cron (sekret w nagłówku) albo zalogowany dyspozytor („Sprawdź teraz").
  // verify_jwt jest wyłączone, więc autoryzację sprawdzamy tutaj — jedno i drugie wprost.
  const providedSecret = req.headers.get("x-ingest-secret") ?? "";
  let authorized = Boolean(ingestSecret) && providedSecret === ingestSecret;
  if (!authorized) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (token) {
      const { data } = await admin.auth.getUser(token);
      authorized = Boolean(data?.user);
    }
  }
  if (!authorized) return json({ ok: false, reason: "unauthorized", error: "Brak uprawnień do uruchomienia odczytu skrzynki." }, 401);

  const startedAt = new Date().toISOString();

  let source: MailSource;
  try {
    source = buildMailSource(env);
  } catch (e) {
    // Brak konfiguracji to nie awaria — appka ma o tym mówić wprost w UI, a nie milczeć.
    const error = (e as Error).message;
    await admin.from("email_ingest_state").update({ last_run_at: startedAt, last_error: error }).eq("id", true);
    return json({ ok: false, reason: "not_configured", error }, 200);
  }

  let ingested = 0;
  let ignored = 0;
  let skipped = 0;

  try {
    const { data: state } = await admin.from("email_ingest_state").select("*").eq("id", true).single();
    const fetched = await source.fetchSince(String(state?.cursor ?? ""), MAX_MESSAGES_PER_RUN);

    // Zbiory do dopasowania maila do istniejącego zlecenia — pobrane RAZ na przebieg, nie per mail.
    // Kontener obok numeru: mail bywa pisany "kontener NYKU9911861 stoi na terminalu", bez numeru
    // zlecenia — prefiltr używa go jako słabszego sygnału (patrz assessRelevance).
    const { data: loadRows } = await admin
      .from("loads")
      .select("id, order_number, container_number")
      .not("order_number", "is", null);
    const loadsByNormalizedNumber = new Map<string, { id: string; order_number: string; container_number: string | null }>();
    for (const row of loadRows ?? []) {
      const normalized = normalizeOrderNumber(String(row.order_number ?? ""));
      if (normalized.length >= MIN_ORDER_NUMBER_LENGTH) {
        loadsByNormalizedNumber.set(normalized, row as { id: string; order_number: string; container_number: string | null });
      }
    }
    // Wątek → zlecenie. Klucz to conversationId (Graph) albo Message-ID poprzedniej wiadomości
    // (IMAP), więc indeksujemy jedno i drugie.
    const { data: threadRows } = await admin
      .from("email_messages")
      .select("message_id, thread_refs, matched_load_id")
      .not("matched_load_id", "is", null);
    const threadLoadByRef = new Map<string, string>();
    for (const row of threadRows ?? []) {
      const loadId = String(row.matched_load_id);
      if (row.message_id) threadLoadByRef.set(String(row.message_id), loadId);
      for (const ref of (row.thread_refs ?? []) as string[]) threadLoadByRef.set(ref, loadId);
    }

    for (const mail of fetched.messages) {
      const relevance = assessRelevance(mail, loadsByNormalizedNumber, threadLoadByRef);

      const record: Record<string, unknown> = {
        message_id: mail.messageId,
        thread_refs: mail.threadRefs,
        from_email: mail.fromEmail,
        from_name: mail.fromName,
        subject: mail.subject,
        body_text: mail.bodyText,
        received_at: mail.receivedAt,
        matched_load_id: relevance.matchedLoadId,
        match_reason: relevance.reason,
        status: relevance.relevant ? "new" : "ignored",
      };

      const warnings: string[] = [];
      const attachmentRows: Record<string, unknown>[] = [];

      if (relevance.relevant) {
        let merged = EMPTY_PARSED_ORDER;
        const sources: string[] = [];

        for (const pdf of mail.attachments) {
          const storagePath = `${mail.messageId.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80)}/${pdf.filename}`;
          const upload = await admin.storage.from("order-emails").upload(storagePath, pdf.bytes, {
            contentType: "application/pdf",
            upsert: true,
          });

          let parsed: ParsedOrder | null = null;
          let parseSource = "";
          let attachmentError = "";

          // 1) Znany szablon — darmowy i deterministyczny, więc zawsze pierwszy.
          let text = "";
          try {
            text = await extractPdfText(pdf.bytes);
          } catch (e) {
            // Skan bez warstwy tekstowej to nie koniec — Claude dostaje oryginalny PDF.
            attachmentError = `tekst z PDF-a: ${(e as Error).message}`;
          }
          const template = text ? matchKnownTemplate(text) : null;
          if (template) {
            parsed = template.parsed;
            parseSource = template.name;
          } else {
            // 2) Claude — tylko dla dokumentów spoza szablonów.
            const viaClaude = await parseViaClaude(supabaseUrl, serviceKey, { pdfBase64: toBase64(pdf.bytes) });
            if (viaClaude.ok) {
              parsed = viaClaude.parsed;
              parseSource = `${pdf.filename} — odczyt przez Claude`;
            } else {
              attachmentError = attachmentError
                ? `${attachmentError}; Claude: ${viaClaude.error}`
                : `Claude: ${viaClaude.error}`;
              warnings.push(`${pdf.filename}: nie rozpoznano szablonu, a odczyt przez Claude nie zadziałał (${viaClaude.error}) — pola trzeba wpisać ręcznie.`);
            }
          }

          if (parsed) {
            if (merged.order_number && parsed.order_number && merged.order_number !== parsed.order_number) {
              warnings.push(`${pdf.filename}: numer zlecenia ${parsed.order_number} różni się od ${merged.order_number} z poprzedniego dokumentu — sprawdź, czy to to samo zlecenie.`);
            }
            if (parsed.rate_currency && parsed.rate_currency.toUpperCase() !== "PLN") {
              warnings.push(`${pdf.filename}: stawka w ${parsed.rate_currency}, appka zakłada PLN — sprawdź kwotę.`);
            }
            merged = mergeParsedOrders(merged, parsed);
            sources.push(parseSource);
          }

          attachmentRows.push({
            filename: pdf.filename,
            mime_type: "application/pdf",
            size_bytes: pdf.bytes.byteLength,
            storage_path: upload.error ? null : storagePath,
            parsed: parsed ?? null,
            parse_source: parseSource || null,
            error: upload.error ? `zapis pliku: ${upload.error.message}` : attachmentError || null,
          });
        }

        // Mail bez PDF-a, ale dotyczący znanego zlecenia (odpowiedź w wątku albo numer w treści) —
        // to jest wprost wymóg właściciela: „nawet jak klient dośle informację w treści, program to
        // zobaczy". Do modelu idzie sam tekst, więc koszt jest ułamkiem odczytu PDF-a.
        if (mail.attachments.length === 0 && mail.bodyText.trim()) {
          const viaClaude = await parseViaClaude(supabaseUrl, serviceKey, {
            text: `Temat: ${mail.subject}\nOd: ${mail.fromName} <${mail.fromEmail}>\n\n${mail.bodyText}`,
          });
          if (viaClaude.ok) {
            merged = mergeParsedOrders(merged, viaClaude.parsed);
            sources.push("treść maila — odczyt przez Claude");
          } else {
            warnings.push(`Nie udało się odczytać treści maila przez Claude (${viaClaude.error}) — przejrzyj ją ręcznie.`);
          }
        }

        // Domyślna „Data" = dzień roboczy przed rozładunkiem/załadunkiem — ta sama reguła co przy
        // ręcznym imporcie, żeby zlecenie z maila trafiało w tabeli tam, gdzie wpisane ręcznie.
        if (!merged.load_date && merged.delivery_date) {
          merged = { ...merged, load_date: previousWorkingDay(merged.delivery_date) };
        }

        record.parsed = merged;
        record.parse_source = sources.join(", ") || null;
        record.warnings = warnings;
      }

      const { data: inserted, error: insertError } = await admin
        .from("email_messages")
        .insert(record)
        .select("id")
        .single();

      if (insertError) {
        // 23505 = ten mail już jest w bazie (powtórka po restarcie albo kursor cofnięty o sekundę).
        // To NIE jest błąd — dedup po Message-ID właśnie tak ma działać.
        if (insertError.code === "23505") skipped++;
        else warnings.push(`zapis maila: ${insertError.message}`);
      } else if (inserted) {
        if (attachmentRows.length > 0) {
          await admin.from("email_attachments").insert(
            attachmentRows.map((row) => ({ ...row, email_message_id: inserted.id })),
          );
        }
        if (relevance.relevant) ingested++;
        else ignored++;
        // Kolejna wiadomość z tego samego wątku w TYM SAMYM przebiegu ma się już podpiąć.
        if (relevance.matchedLoadId) {
          threadLoadByRef.set(mail.messageId, relevance.matchedLoadId);
          for (const ref of mail.threadRefs) threadLoadByRef.set(ref, relevance.matchedLoadId);
        }
      }
    }

    await admin
      .from("email_ingest_state")
      .update({
        cursor: fetched.cursor,
        source: source.name,
        last_run_at: startedAt,
        last_ok_at: new Date().toISOString(),
        last_error: null,
        seen_total: Number(state?.seen_total ?? 0) + fetched.messages.length,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);

    return json({
      ok: true,
      zrodlo: source.name,
      sprawdzono: fetched.messages.length,
      zaleglych: fetched.remaining,
      doSkrzynki: ingested,
      pominieto: ignored,
      duplikaty: skipped,
    });
  } catch (e) {
    const message = (e as Error).message;
    await admin
      .from("email_ingest_state")
      .update({ last_run_at: startedAt, last_error: message, updated_at: new Date().toISOString() })
      .eq("id", true);
    return json({ ok: false, reason: "mail", error: message }, 200);
  } finally {
    source.close();
  }
});
