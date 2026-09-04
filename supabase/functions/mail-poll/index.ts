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
//   2b. szablon NAUCZONY z wcześniej zapisanych zleceń (migracja 0023) — też darmowy,
//   3. Claude (parse-order-pdf) — TYLKO z guzika w Skrzynce, nigdy stąd (patrz niżej).
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
import { assessRelevance, type MarkingRule, MIN_ORDER_NUMBER_LENGTH, normalizeOrderNumber } from "./relevance.ts";
import { extractPdfText } from "./pdfText.ts";
import { matchKnownTemplate } from "./shared/orderTemplates.ts";
import { postalCodeNearCity } from "./shared/postalFromText.ts";
import { matchLearnedTemplate, type LearnedTemplateLike } from "./shared/readTemplate.ts";
import { previousWorkingDay } from "./shared/workingDays.ts";
import {
  EMPTY_PARSED_ORDER,
  mergeParsedOrders,
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
// UWAGA: tu STAŁA funkcja wołająca `parse-order-pdf` (płatny odczyt przez Claude). Została
// usunięta świadomie i NIE należy jej tu przywracać.
//
// Poller chodzi co 2 minuty i nie ma pojęcia, czy ktokolwiek potrzebuje danego maila. Wołany
// stąd model wyczerpał właścicielowi środki w Claude Console przez jedną noc (515 wywołań),
// bo płacił także za maile, które już były w bazie. Płatny odczyt rusza teraz wyłącznie
// z guzika "Odczytaj przez Claude" w Skrzynce — patrz src/lib/supabase/readEmailWithClaude.ts.
// Sama funkcja `parse-order-pdf` odrzuca dziś wywołania spoza sesji zalogowanego człowieka.
// ------------------------------------------------------------

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

    // Szablony NAUCZONE z zapisanych zleceń (migracja 0023). Skrzynka używa ich tak samo jak ręczny
    // import — i to tutaj są najbardziej warte: mail przychodzi sam, więc bez nich każdy załącznik
    // spoza ręcznie napisanych szablonów czekałby na płatny odczyt z kliknięcia człowieka.
    const { data: learnedRows } = await admin
      .from("order_templates")
      .select("id,label,forwarder_name,forwarder_nip,doc_kind,labels,rules,status")
      .eq("status", "aktywny");
    const learnedTemplates = (learnedRows ?? []) as LearnedTemplateLike[];

    // Reguła „czytaj tylko oznaczone" (migracja 0024) — u klienta pracownik zaznacza kolorową
    // kategorią zlecenia do wpisania. Konfiguracja stoi przy stanie odczytu, bo to wspólna reguła
    // firmy, a nie ustawienie prywatne dyspozytora.
    const marking: MarkingRule = {
      onlyMarked: state?.only_marked ?? true,
      categories: (state?.marked_categories ?? []) as string[],
    };
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

    // Które z pobranych wiadomości już mamy. Sprawdzamy to JEDNYM zapytaniem PRZED jakąkolwiek
    // pracą nad nimi — kolejność ma tu wymiar finansowy: poprzednia wersja parsowała mail
    // (płatnie), a dopiero potem odbijała się o `UNIQUE (message_id)` przy zapisie. Kursor Graph
    // celowo porównuje ">=" (lepiej powtórzyć wiadomość niż ją zgubić), więc te same maile wracały
    // w każdym przebiegu co 2 minuty i płaciliśmy za nie od nowa: 515 wywołań przez jedną noc.
    const { data: juzMamy } = await admin
      .from("email_messages")
      .select("message_id")
      .in("message_id", fetched.messages.map((m) => m.messageId));
    const znane = new Set((juzMamy ?? []).map((r) => String(r.message_id)));

    for (const mail of fetched.messages) {
      if (znane.has(mail.messageId)) {
        skipped++;
        continue;
      }
      const relevance = assessRelevance(mail, loadsByNormalizedNumber, threadLoadByRef, marking);

      const record: Record<string, unknown> = {
        message_id: mail.messageId,
        thread_refs: mail.threadRefs,
        from_email: mail.fromEmail,
        from_name: mail.fromName,
        subject: mail.subject,
        body_text: mail.bodyText,
        received_at: mail.receivedAt,
        // Oznaczenia ze skrzynki zapisujemy ZAWSZE, także dla maili pominiętych: dzięki temu
        // w Skrzynce widać, czym te wiadomości są naprawdę oznaczone, i da się zawęzić regułę do
        // właściwej kategorii bez zgadywania jej nazwy.
        categories: mail.categories,
        flagged: mail.flagged,
        matched_load_id: relevance.matchedLoadId,
        match_reason: relevance.reason,
        status: relevance.relevant ? "new" : "ignored",
      };

      const warnings: string[] = [];
      const attachmentRows: Record<string, unknown>[] = [];

      if (relevance.relevant) {
        let merged = EMPTY_PARSED_ORDER;
        const sources: string[] = [];
        // Teksty wszystkich załączników — potrzebne jeszcze raz po scaleniu, przy szukaniu kodu
        // pocztowego (miasto bywa w jednym dokumencie, kod w drugim).
        const teksty: string[] = [];

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
            teksty.push(text);
          } catch (e) {
            // Skan bez warstwy tekstowej to nie koniec — Claude dostaje oryginalny PDF.
            attachmentError = `tekst z PDF-a: ${(e as Error).message}`;
          }
          const template = text ? matchKnownTemplate(text) : null;
          const learned = template || !text ? null : matchLearnedTemplate(text, learnedTemplates);
          if (template) {
            parsed = template.parsed;
            parseSource = template.name;
          } else if (learned && learned.missing.length === 0) {
            // Nauczony szablon jest darmowy i deterministyczny, więc wchodzi przed modelem.
            // Warunek "komplet kluczowych pól" jest ten sam co w oknie importu (decyzja
            // właściciela) — niekompletny odczyt zostawia maila do przejrzenia zamiast tworzyć
            // propozycję z dziurami.
            parsed = learned.parsed;
            parseSource = learned.template.label;
          } else {
            // 2) Odczyt przez Claude JEST PŁATNY i NIE dzieje się tutaj.
            //
            // Właściciel: "program wykorzystał wszystkie fundusze Claude Console — odczytem
            // zleceń; niech płatny odczyt będzie dopiero po moim kliknięciu". Poller robi więc
            // wyłącznie rzeczy darmowe (prefiltr, znane szablony), a model rusza z guzika
            // "Odczytaj przez Claude" w Skrzynce, przy konkretnym mailu, który ktoś ogląda.
            //
            // Mail zostaje w kolejce z pustym `parse_source` — to jest dla appki znak "jeszcze
            // nieodczytany" i podstawa, żeby pokazać ten guzik.
            warnings.push(
              learned
                ? `${pdf.filename}: nauczony szablon „${learned.template.label}" nie odczytał kompletu pól (brakuje: ${learned.missing.join(", ")}) — kliknij „Odczytaj przez Claude" w Skrzynce, gdy będzie potrzebny.`
                : `${pdf.filename}: dokument spoza znanych szablonów — kliknij „Odczytaj przez Claude" w Skrzynce, gdy będzie potrzebny.`
            );
          }

          // Kod pocztowy decyduje o stawce dla kierowcy, a odczyt oddaje zwykle sam adres. Szukamy
          // go w tekście PRZY nazwie miejscowości z tego dokumentu — ta sama reguła co przy ręcznym
          // wgraniu pliku (src/lib/driverRates/postalFromText.ts), więc zlecenie z maila nie jest
          // uboższe od tego samego zlecenia wgranego z dysku.
          if (parsed && !parsed.postal_code && text) {
            const kod = postalCodeNearCity(text, parsed.city);
            if (kod) parsed = { ...parsed, postal_code: kod };
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

        // Mail bez PDF-a, ale dotyczący znanego zlecenia (odpowiedź w wątku albo numer w treści)
        // — wymóg właściciela: "nawet jak klient dośle informację w treści, program to zobaczy".
        // Sam mail trafia więc do Skrzynki, ale jego ODCZYT (płatny) czeka na kliknięcie; treść
        // widać w panelu, więc dyspozytor często rozstrzygnie sprawę bez wydawania grosza.
        if (mail.attachments.length === 0 && mail.bodyText.trim()) {
          warnings.push('Treść maila nieodczytana — kliknij „Odczytaj przez Claude", jeśli chcesz z niej wyciągnąć pola zlecenia.');
        }

        // Miasto bywa w jednym dokumencie, a kod pocztowy w drugim (zlecenie + list przewozowy),
        // więc po scaleniu próbujemy jeszcze raz — już z miejscowością z kompletu pól.
        if (!merged.postal_code && merged.city) {
          for (const tekst of teksty) {
            const kod = postalCodeNearCity(tekst, merged.city);
            if (kod) {
              merged = { ...merged, postal_code: kod };
              break;
            }
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
