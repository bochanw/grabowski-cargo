"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { triggerMailPoll, useEmailInbox, useIngestState, useSetEmailStatus } from "@/hooks/useEmailInbox";
import { useLinkExistingDocument } from "@/hooks/useLoadDocuments";
import { guessDocumentKind } from "@/types/loadDocument";
import type { EmailAttachment } from "@/types/emailMessage";
import type { EmailMessage } from "@/types/emailMessage";
import type { Load } from "@/types/load";
import { ImportOrderDialog } from "./ImportOrderDialog";
import { readEmailWithClaude } from "@/lib/supabase/readEmailWithClaude";
import type { LearningDocument } from "@/lib/orderTemplates/autoLearn";

const TIME_FORMATTER = new Intl.DateTimeFormat("pl-PL", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

// Skrót rekordu do podglądu w wąskim panelu — tyle, żeby dyspozytor rozpoznał zlecenie bez
// otwierania formularza. Pełny komplet pól i tak zobaczy po kliknięciu.
const PREVIEW_FIELDS: { key: keyof NonNullable<EmailMessage["parsed"]>; label: string }[] = [
  { key: "order_number", label: "Nr zlecenia" },
  { key: "forwarder", label: "Spedycja" },
  { key: "container_number", label: "Kontener" },
  { key: "city", label: "Miejscowość" },
  { key: "delivery_date", label: "Data" },
  { key: "rate_amount", label: "Stawka" },
];

function formatAge(iso: string | null): string {
  if (!iso) return "";
  return TIME_FORMATTER.format(new Date(iso));
}

/**
 * „Skrzynka" — kolejka maili odczytanych ze skrzynki firmowej przez Edge Function `mail-poll`.
 *
 * Właściciel wybrał wprost kolejkę do zatwierdzenia zamiast zapisu automatycznego: zlecenie
 * powstaje DOPIERO po kliknięciu dyspozytora, więc pomyłka modelu nigdy nie wchodzi cicho do bazy
 * ani na fakturę. Ten panel to całe UI tej decyzji — obejrzyj, popraw, zatwierdź albo odrzuć.
 */
export function SkrzynkaPanel({ onClose, loads }: { onClose: () => void; loads: Load[] }) {
  const { data: messages, isLoading, isError, error } = useEmailInbox();
  const { data: ingestState } = useIngestState();
  const setStatus = useSetEmailStatus();
  const linkDocument = useLinkExistingDocument();
  const [openMail, setOpenMail] = useState<EmailMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Który mail jest właśnie odczytywany przez Claude. PŁATNE, więc wyłącznie na kliknięcie —
  // patrz komentarz w src/lib/supabase/readEmailWithClaude.ts (skrzynka robiła to sama i przez
  // jedną noc wyczerpała środki w Claude Console).
  const [czytany, setCzytany] = useState<string | null>(null);
  // Teksty załączników odczytanych przez Claude — po zapisie zlecenia appka uczy się z nich układu
  // dokumentu, żeby kolejny mail od tego spedytora był darmowy (patrz autoLearn.ts).
  const [materialDoNauki, setMaterialDoNauki] = useState<LearningDocument[]>([]);

  async function odczytajPrzezClaude(mail: EmailMessage) {
    setCzytany(mail.id);
    setNotice(null);
    const { data: zalaczniki } = await supabase
      .from("email_attachments")
      .select("filename, storage_path")
      .eq("email_message_id", mail.id);

    const wynik = await readEmailWithClaude(mail, zalaczniki ?? []);
    setCzytany(null);
    if (!wynik.ok) {
      setNotice(`Nie udało się odczytać: ${wynik.error}`);
      return;
    }
    // Otwieramy formularz od razu — dyspozytor zapłacił za ten odczyt, więc ma go zobaczyć,
    // a nie szukać po panelu. Wynik jest już zapisany przy mailu, więc drugie wejście jest darmowe.
    setMaterialDoNauki(wynik.documents);
    setOpenMail({ ...mail, parsed: wynik.parsed, parse_source: wynik.source });
  }

  async function checkNow() {
    setChecking(true);
    setNotice(null);
    const result = await triggerMailPoll();
    setNotice(result.message);
    setChecking(false);
  }

  async function reject(mail: EmailMessage) {
    const error = await setStatus(mail.id, "rejected");
    if (error) setNotice(`Nie udało się odrzucić: ${error}`);
  }

  const matchedLoad = openMail?.matched_load_id
    ? loads.find((l) => l.id === openMail.matched_load_id)
    : undefined;

  return (
    <>
      <aside className="flex w-[26rem] shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Skrzynka {messages && messages.length > 0 ? `(${messages.length})` : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={checkNow}
              disabled={checking}
              className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              {checking ? "Sprawdzam…" : "Sprawdź teraz"}
            </button>
            <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
              ✕
            </button>
          </div>
        </div>

        {/* Martwy odczyt musi rzucać się w oczy — sekret Microsoftu wygasa, zgoda administratora
            bywa cofana, a bez tego appka po prostu przestałaby dostawać zlecenia w ciszy. */}
        {ingestState?.last_error && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <div className="font-medium">Odczyt skrzynki nie działa</div>
            <div className="mt-0.5 break-words">{ingestState.last_error}</div>
          </div>
        )}
        {ingestState && !ingestState.last_error && (
          <div className="border-b border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-900">
            {ingestState.source ?? "źródło nieustawione"} ·{" "}
            {ingestState.last_ok_at ? `ostatnio ${formatAge(ingestState.last_ok_at)}` : "jeszcze nie odpytano"}
          </div>
        )}
        {notice && (
          <div className="border-b border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-900 dark:bg-zinc-900 dark:text-zinc-300">
            {notice}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading && <p className="p-3 text-xs text-zinc-500">Wczytywanie…</p>}
          {isError && (
            <p className="p-3 text-xs text-red-600">
              Nie udało się wczytać skrzynki: {error instanceof Error ? error.message : String(error)}
            </p>
          )}
          {messages && messages.length === 0 && (
            <p className="p-3 text-xs text-zinc-500">
              Brak nowych zleceń w skrzynce. Maile bez PDF-a, numeru zlecenia i powiązania z wątkiem
              są pomijane — nie trafiają tutaj i nie kosztują odczytu.
            </p>
          )}

          {messages?.map((mail) => {
            const linkedLoad = mail.matched_load_id ? loads.find((l) => l.id === mail.matched_load_id) : undefined;
            return (
              <div key={mail.id} className="border-b border-zinc-100 px-3 py-2 text-xs dark:border-zinc-900">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {mail.from_name || mail.from_email || "(nieznany nadawca)"}
                  </span>
                  <span className="shrink-0 text-zinc-400">{formatAge(mail.received_at)}</span>
                </div>
                <div className="text-zinc-700 dark:text-zinc-300">{mail.subject || "(bez tematu)"}</div>

                {/* Dlaczego ten mail w ogóle tu jest — dyspozytor widzi podstawę dopasowania,
                    zamiast zgadywać, czemu appka uznała go za zlecenie. */}
                {mail.match_reason && (
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {linkedLoad ? `↳ do zlecenia ${linkedLoad.order_number ?? ""} · ` : ""}
                    {mail.match_reason}
                  </div>
                )}
                {mail.parse_source ? (
                  <div className="text-[11px] text-zinc-500">Odczytano: {mail.parse_source}</div>
                ) : (
                  <div className="text-[11px] text-zinc-500">
                    Nieodczytany — dokument spoza znanych szablonów. Kliknij „Odczytaj przez Claude",
                    gdy tego maila faktycznie potrzebujesz.
                  </div>
                )}

                {mail.parsed && (
                  <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    {PREVIEW_FIELDS.map(({ key, label }) => {
                      const value = mail.parsed?.[key];
                      if (value === null || value === undefined || value === "") return null;
                      return (
                        <div key={key} className="contents">
                          <dt className="text-zinc-400">{label}</dt>
                          <dd className="truncate text-zinc-800 dark:text-zinc-200">{String(value)}</dd>
                        </div>
                      );
                    })}
                  </dl>
                )}

                {mail.warnings.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-700 dark:text-amber-500">
                    {mail.warnings.map((warning) => (
                      <li key={warning} className="break-words">⚠ {warning}</li>
                    ))}
                  </ul>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  {/* Odczyt przez Claude jest PŁATNY, więc rusza wyłącznie stąd — z kliknięcia.
                      `mail-poll` odczytuje za darmo tylko znane szablony i stąd brak `parse_source`
                      znaczy "nikt tego jeszcze nie przeczytał". */}
                  {!mail.parse_source && (
                    <button
                      type="button"
                      onClick={() => void odczytajPrzezClaude(mail)}
                      disabled={czytany !== null}
                      title="Wyśle dokument (albo treść maila) do odczytu przez Claude — to jedyne płatne miejsce w appce"
                      className="rounded border border-amber-400 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-950"
                    >
                      {czytany === mail.id ? "Odczytuję…" : "Odczytaj przez Claude (płatne)"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpenMail(mail)}
                    className="rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {linkedLoad ? `Dopnij do ${linkedLoad.order_number ?? "zlecenia"}` : "Utwórz zlecenie"}
                  </button>
                  <button
                    type="button"
                    onClick={() => reject(mail)}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    Odrzuć
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Ten sam formularz co przy ręcznym imporcie — dyspozytor widzi i poprawia KAŻDE pole przed
          zapisem. Mail powiązany z istniejącym zleceniem wchodzi w trybie "attach": wypełnia tylko
          puste pola, więc nie nadpisze tego, co ktoś już poprawił ręcznie. */}
      {openMail && (
        <ImportOrderDialog
          // Klucz per wiadomość: bez niego React zachowałby stan formularza (i materiał do nauki)
          // przy przejściu z jednego maila na drugi.
          key={openMail.id}
          mode={matchedLoad ? "attach" : "import"}
          existingLoad={matchedLoad}
          initialParsed={openMail.parsed ?? undefined}
          initialLearningDocs={materialDoNauki}
          recentLoads={loads}
          onLearned={(notes) => setNotice(notes.join(" "))}
          onClose={() => {
            setOpenMail(null);
            setMaterialDoNauki([]);
          }}
          onSaved={async (loadId) => {
            await setStatus(openMail.id, "accepted");
            // Załącznik maila JUŻ leży w Storage (bucket `order-emails`, zapisał go `mail-poll`) —
            // podpinamy istniejący plik do zlecenia zamiast kopiować go drugi raz. Dzięki temu
            // zlecenie z maila ma swoje oryginały tak samo jak zlecenie wgrane ręcznie.
            const { data } = await supabase
              .from("email_attachments")
              .select("*")
              .eq("email_message_id", openMail.id);
            for (const attachment of (data ?? []) as EmailAttachment[]) {
              if (!attachment.storage_path) continue;
              const error = await linkDocument({
                loadId,
                bucket: "order-emails",
                storagePath: attachment.storage_path,
                fileName: attachment.filename,
                mimeType: attachment.mime_type,
                sizeBytes: attachment.size_bytes,
                kind: guessDocumentKind(attachment.filename ?? "", attachment.parse_source),
                parseSource: attachment.parse_source,
              });
              if (error) setNotice(`Zlecenie zapisane, ale nie udało się podpiąć załącznika ${attachment.filename ?? ""}: ${error}`);
            }
            setOpenMail(null);
          }}
        />
      )}
    </>
  );
}
