"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { triggerMailPoll, useEmailInbox, useIngestState, useSetEmailStatus, useSetIngestMarking, useSkippedEmails } from "@/hooks/useEmailInbox";
import { useLinkExistingDocument } from "@/hooks/useLoadDocuments";
import { guessDocumentKind } from "@/types/loadDocument";
import type { EmailAttachment } from "@/types/emailMessage";
import type { EmailMessage } from "@/types/emailMessage";
import type { Load } from "@/types/load";
import { ImportOrderDialog } from "./ImportOrderDialog";
import type { SourceItem } from "./SourcePreview";
import { ordersFromAttachments } from "@/lib/loads/documentGroups";
import { matchExistingLoad } from "@/lib/loads/orderNumber";
import { normalizeParsedOrder, type ParsedOrder } from "@/types/parsedOrder";
import { readEmailWithClaude } from "@/lib/supabase/readEmailWithClaude";
import type { LearningDocument } from "@/lib/orderTemplates/autoLearn";
import { learningDocsFromStorage } from "@/lib/orderTemplates/fromStored";

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
  // ŹRÓDŁO otwartego maila (treść + załączniki w Storage) — wędruje do formularza, żeby dyspozytor
  // poprawiał pola PATRZĄC na dokument. Właściciel: "odczytując zlecenia z maila nie widzę źródła —
  // więc nie jestem w stanie skorygować błędów".
  const [zrodla, setZrodla] = useState<SourceItem[]>([]);
  // Zlecenia, które niesie otwarty mail — zwykle jedno, ale bywa kilka (osobne załączniki).
  const [zlecenia, setZlecenia] = useState<{ parsed: ParsedOrder; externalIds: string[] }[]>([]);
  // Podgląd samej treści w liście — bez sieci, więc da się nim rzucić okiem PRZED decyzją
  // o płatnym odczycie.
  const [trescMaila, setTrescMaila] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Który mail jest właśnie odczytywany przez Claude. PŁATNE, więc wyłącznie na kliknięcie —
  // patrz komentarz w src/lib/supabase/readEmailWithClaude.ts (skrzynka robiła to sama i przez
  // jedną noc wyczerpała środki w Claude Console).
  const [czytany, setCzytany] = useState<string | null>(null);
  // Teksty załączników odczytanych przez Claude — po zapisie zlecenia appka uczy się z nich układu
  // dokumentu, żeby kolejny mail od tego spedytora był darmowy (patrz autoLearn.ts).
  const [materialDoNauki, setMaterialDoNauki] = useState<LearningDocument[]>([]);
  // Reguła „czytaj tylko oznaczone" i podgląd pominiętych — patrz migracja 0024. Pominięte
  // pobieramy dopiero po rozwinięciu, bo to widok diagnostyczny, nie codzienna praca.
  const [pokazPominiete, setPokazPominiete] = useState(false);
  const { data: pominiete = [] } = useSkippedEmails(pokazPominiete);
  const setMarking = useSetIngestMarking();

  // Kategorie FAKTYCZNIE spotkane w skrzynce — nazwy nadaje użytkownik Outlooka, więc appka nie
  // może ich znać z góry. Dyspozytor wybiera właściwą z listy tego, co naprawdę przyszło.
  const spotkaneKategorie = [
    ...new Set([...(messages ?? []), ...pominiete].flatMap((m) => m.categories ?? [])),
  ].sort((a, b) => a.localeCompare(b, "pl"));
  const wybraneKategorie = ingestState?.marked_categories ?? [];

  async function przelaczKategorie(name: string) {
    const next = wybraneKategorie.includes(name)
      ? wybraneKategorie.filter((c) => c !== name)
      : [...wybraneKategorie, name];
    const err = await setMarking({ marked_categories: next });
    setNotice(
      err
        ? `Nie udało się zapisać reguły: ${err}`
        : next.length === 0
          ? "Liczy się teraz DOWOLNE oznaczenie (kolor albo flaga)."
          : `Propozycje tylko z maili oznaczonych: ${next.join(", ")}.`
    );
  }

  /**
   * Załączniki maila leżą w prywatnym buckecie `order-emails` (zapisał je `mail-poll`), więc do
   * podglądu potrzebny jest podpisany URL — buduje go dopiero SourcePreview, tutaj wystarczy
   * wskazanie pliku. Treść maila idzie osobną zakładką: bywa JEDYNYM źródłem (zmiana terminu
   * w treści, bez załącznika).
   */
  async function pobierzZalaczniki(mail: EmailMessage): Promise<EmailAttachment[]> {
    const { data, error } = await supabase
      .from("email_attachments")
      .select("*")
      .eq("email_message_id", mail.id)
      .order("id", { ascending: true });
    if (error) setNotice(`Nie udało się wczytać załączników: ${error.message}`);
    return (data ?? []) as EmailAttachment[];
  }

  function zbudujZrodla(mail: EmailMessage, zalaczniki: EmailAttachment[]): SourceItem[] {
    const items: SourceItem[] = [];
    // Mail BEZ załączników to normalna sytuacja (właściciel: „czasami mail nie ma załączników") —
    // wtedy jedynym źródłem jest treść, i to ona musi być widoczna obok pól.
    if ((mail.body_text ?? "").trim()) {
      items.push({
        id: `mail-${mail.id}`,
        label: "Treść maila",
        kind: "text",
        text: mail.body_text ?? "",
        note: [mail.from_name || mail.from_email, mail.subject].filter(Boolean).join(" · "),
      });
    }
    for (const attachment of zalaczniki) {
      if (!attachment.storage_path) continue;
      items.push({
        id: `zal-${attachment.id}`,
        label: attachment.filename ?? "załącznik.pdf",
        kind: "pdf",
        bucket: "order-emails",
        path: attachment.storage_path,
        note: attachment.parse_source ? `Odczytano: ${attachment.parse_source}` : attachment.error || undefined,
      });
    }
    return items;
  }

  /**
   * ILE ZLECEŃ niesie ten mail — rozstrzyga numer zlecenia odczytany z KAŻDEGO załącznika osobno
   * (`email_attachments.parsed`). Reguły i przypadki brzegowe: src/lib/loads/documentGroups.ts.
   */
  function zbudujZlecenia(mail: EmailMessage, zalaczniki: EmailAttachment[]) {
    return ordersFromAttachments(
      mail.parsed,
      zalaczniki.map((a) => ({
        id: a.id,
        filename: a.filename,
        parsed: a.parsed ? normalizeParsedOrder(a.parsed) : null,
      }))
    );
  }

  /**
   * Materiał do auto-nauki z załączników LEŻĄCYCH JUŻ w buckecie maili.
   *
   * Bez tego appka uczyła się WYŁĄCZNIE przy świeżym płatnym odczycie: mail odczytany wcześniej
   * (wynik zapisany przy wiadomości, więc drugie wejście jest darmowe) otwierał się bez tekstu
   * dokumentów, a zapisane z niego zlecenie nie zostawiało po sobie żadnego szablonu.
   * Wyciągnięcie tekstu jest lokalne (pdf.js) i nic nie kosztuje.
   */
  async function materialZZalacznikow(zalaczniki: EmailAttachment[]) {
    const pliki = zalaczniki
      .filter((a) => a.storage_path)
      .map((a) => ({
        bucket: "order-emails",
        path: a.storage_path as string,
        fileName: a.filename ?? "załącznik.pdf",
        mimeType: a.mime_type,
        parseSource: a.parse_source ?? "załącznik z maila",
      }));
    if (pliki.length === 0) return [];
    const { documents } = await learningDocsFromStorage(pliki);
    return documents;
  }

  async function otworzMaila(mail: EmailMessage) {
    const zalaczniki = await pobierzZalaczniki(mail);
    // Materiał do nauki PRZED otwarciem okna: `ImportOrderDialog` bierze go tylko przy montowaniu,
    // więc dostarczony chwilę później nie trafiłby już do zapisu.
    setMaterialDoNauki(await materialZZalacznikow(zalaczniki));
    setOpenMail(mail);
    setZrodla(zbudujZrodla(mail, zalaczniki));
    setZlecenia(zbudujZlecenia(mail, zalaczniki));
  }

  async function odczytajPrzezClaude(mail: EmailMessage) {
    setCzytany(mail.id);
    setNotice(null);
    const zalaczniki = await pobierzZalaczniki(mail);

    const wynik = await readEmailWithClaude(mail, zalaczniki);
    setCzytany(null);
    if (!wynik.ok) {
      setNotice(`Nie udało się odczytać: ${wynik.error}`);
      return;
    }
    // Otwieramy formularz od razu — dyspozytor zapłacił za ten odczyt, więc ma go zobaczyć,
    // a nie szukać po panelu. Wynik jest już zapisany przy mailu, więc drugie wejście jest darmowe.
    setMaterialDoNauki(wynik.documents);
    const odczytany = { ...mail, parsed: wynik.parsed, parse_source: wynik.source };
    // Po odczycie każdy załącznik ma już własne pola — pobieramy je jeszcze raz, bo dopiero teraz
    // widać, czy ten mail to jedno zlecenie, czy kilka.
    const poOdczycie = await pobierzZalaczniki(mail);
    setOpenMail(odczytany);
    setZrodla(zbudujZrodla(odczytany, poOdczycie));
    setZlecenia(zbudujZlecenia(odczytany, poOdczycie));
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

  /**
   * Czy zlecenie z tego maila JEST JUŻ w Zestawieniu.
   *
   * Zgłoszenie właściciela: „mimo utworzenia zlecenia dalej je widzę i chcę drugi raz wpisać" —
   * bo to samo zlecenie przychodzi w KILKU mailach (wątek, ponowna wysyłka, osobny mail z listem
   * przewozowym). Zaakceptowanie jednego maila nie mówi nic o pozostałych.
   *
   * `matched_load_id` od pollera nie wystarcza: dopasowuje po TEKŚCIE maila w chwili odczytu, więc
   * zlecenie utworzone PÓŹNIEJ (albo z numerem, którego w treści nie było) nie zostanie złapane.
   * Dlatego liczymy to na bieżąco z aktualnej listy zleceń — tą samą regułą, którą okno importu
   * chroni przed duplikatem (numer, także z przestawionymi członami, a w drugiej kolejności kontener).
   */
  function rozpoznajZlecenie(mail: EmailMessage): { load: Load; reason: string; pewne: boolean } | null {
    if (mail.matched_load_id) {
      const load = loads.find((l) => l.id === mail.matched_load_id);
      if (load) return { load, reason: mail.match_reason ?? "powiązany z tym zleceniem", pewne: true };
    }
    if (!mail.parsed) return null;
    const match = matchExistingLoad(loads, {
      order_number: mail.parsed.order_number,
      container_number: mail.parsed.container_number,
    });
    return match ? { load: match.load, reason: match.reason, pewne: match.auto } : null;
  }

  const rozpoznane = openMail ? rozpoznajZlecenie(openMail) : null;
  // Do okna wchodzi jako "dopnij" tylko dopasowanie PEWNE (numer zlecenia). Sam kontener bywa
  // wspólny dla dwóch różnych zleceń po tygodniach, więc tam decyzję podejmuje dyspozytor w oknie.
  const matchedLoad = rozpoznane?.pewne ? rozpoznane.load : undefined;

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

        {/* Reguła „czytaj tylko oznaczone" — u klienta pracownik zaznacza kolorową kategorią
            zlecenia do wpisania. Nazw kategorii appka nie zna z góry (nadaje je użytkownik
            Outlooka), więc pokazujemy TE, KTÓRE FAKTYCZNIE PRZYSZŁY, zamiast zgadywać. */}
        <div className="border-b border-zinc-100 px-3 py-2 text-[11px] dark:border-zinc-900">
          <label className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={ingestState?.only_marked ?? true}
              onChange={async (e) => {
                const err = await setMarking({ only_marked: e.target.checked });
                setNotice(
                  err
                    ? `Nie udało się zapisać reguły: ${err}`
                    : e.target.checked
                      ? "Nowe zlecenia tylko z maili oznaczonych w skrzynce."
                      : "Nowe zlecenia z każdego maila z PDF-em, jak przed zmianą."
                );
              }}
            />
            Nowe zlecenia tylko z maili <b>oznaczonych</b> (kolor albo flaga)
          </label>
          <p className="mt-1 text-zinc-500">
            Mail dotyczący JUŻ istniejącego zlecenia (odpowiedź w wątku, numer w treści) przechodzi
            zawsze — oznaczenie decyduje tylko o propozycjach nowych zleceń. Appka niczego w skrzynce
            nie zmienia i nie oznacza jako przeczytane.
          </p>
          {spotkaneKategorie.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-zinc-500">Kategorie w skrzynce:</span>
              {spotkaneKategorie.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => void przelaczKategorie(name)}
                  title="Kliknij, żeby zawęzić regułę do tej kategorii"
                  className={`rounded-full border px-2 py-0.5 ${
                    wybraneKategorie.includes(name)
                      ? "border-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                  }`}
                >
                  {name}
                </button>
              ))}
              {wybraneKategorie.length === 0 && <span className="text-zinc-400">(liczy się dowolne)</span>}
            </div>
          )}
          <button
            type="button"
            onClick={() => setPokazPominiete((v) => !v)}
            className="mt-1.5 text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            {pokazPominiete ? "Ukryj pominięte" : "Pokaż pominięte maile"}
          </button>
          {pokazPominiete && (
            <div className="mt-1 max-h-40 overflow-auto rounded bg-zinc-50 p-2 dark:bg-zinc-900">
              {pominiete.length === 0 ? (
                <p className="text-zinc-500">Nic nie zostało pominięte.</p>
              ) : (
                pominiete.map((mail) => (
                  <div key={mail.id} className="border-b border-zinc-200 py-1 last:border-0 dark:border-zinc-800">
                    <div className="text-zinc-700 dark:text-zinc-300">{mail.subject || "(bez tematu)"}</div>
                {((mail.categories ?? []).length > 0 || mail.flagged) && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {(mail.categories ?? []).map((name) => (
                      <span key={name} className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-800 dark:bg-red-950 dark:text-red-300">
                        {name}
                      </span>
                    ))}
                    {mail.flagged && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        flaga
                      </span>
                    )}
                  </div>
                )}
                    <div className="text-zinc-500">
                      {mail.from_name || mail.from_email || "(nieznany nadawca)"} ·{" "}
                      {(mail.categories ?? []).length > 0 ? `oznaczenia: ${mail.categories.join(", ")}` : "bez oznaczeń"}
                      {mail.flagged ? " + flaga" : ""} · {mail.match_reason}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

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
            const znane = rozpoznajZlecenie(mail);
            const linkedLoad = znane?.pewne ? znane.load : undefined;
            return (
              <div key={mail.id} className="border-b border-zinc-100 px-3 py-2 text-xs dark:border-zinc-900">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {mail.from_name || mail.from_email || "(nieznany nadawca)"}
                  </span>
                  <span className="shrink-0 text-zinc-400">{formatAge(mail.received_at)}</span>
                </div>
                <div className="text-zinc-700 dark:text-zinc-300">{mail.subject || "(bez tematu)"}</div>
                {((mail.categories ?? []).length > 0 || mail.flagged) && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {(mail.categories ?? []).map((name) => (
                      <span key={name} className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-800 dark:bg-red-950 dark:text-red-300">
                        {name}
                      </span>
                    ))}
                    {mail.flagged && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        flaga
                      </span>
                    )}
                  </div>
                )}

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

                {znane && (
                  <div
                    data-testid="juz-w-zestawieniu"
                    className={`mt-1.5 rounded border px-2 py-1 text-[11px] ${
                      znane.pewne
                        ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                        : "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200"
                    }`}
                  >
                    {znane.pewne ? (
                      <>
                        <b>Już w Zestawieniu</b> jako {znane.load.order_number || "zlecenie bez numeru"} ({znane.reason}).
                        Mail ZOSTAJE — może nieść nowe informacje (zmiana terminu, dosłany dokument).
                        „Dopnij" wypełni tylko PUSTE pola tego zlecenia i niczego nie nadpisze; drugiego
                        rekordu nie twórz.
                      </>
                    ) : (
                      <>
                        Możliwe, że to zlecenie <b>{znane.load.order_number || "(bez numeru)"}</b> — {znane.reason}.
                        Sprawdź w oknie, zanim utworzysz nowe.
                      </>
                    )}
                  </div>
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
                    onClick={() => void otworzMaila(mail)}
                    className="rounded bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {linkedLoad ? `Dopnij do ${linkedLoad.order_number ?? "zlecenia"}` : "Utwórz zlecenie"}
                  </button>
                  {/* Sam tekst maila, bez sieci i bez kosztu — tyle wystarczy, żeby ocenić, czy to
                      w ogóle zlecenie, zanim ruszy się płatny odczyt. Dokumenty (PDF) widać
                      w oknie zlecenia, obok pól. */}
                  {(mail.body_text ?? "").trim() && (
                    <button
                      type="button"
                      data-testid="pokaz-tresc"
                      onClick={() => setTrescMaila((current) => (current === mail.id ? null : mail.id))}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    >
                      {trescMaila === mail.id ? "Ukryj treść" : "Treść maila"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => reject(mail)}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    Odrzuć
                  </button>
                </div>

                {trescMaila === mail.id && (
                  <pre
                    data-testid="tresc-maila"
                    className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 text-[11px] leading-snug text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  >
                    {mail.body_text}
                  </pre>
                )}
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
          initialOrders={zlecenia.length > 0 ? zlecenia : undefined}
          initialLearningDocs={materialDoNauki}
          initialSources={zrodla}
          recentLoads={loads}
          onLearned={(notes) => setNotice(notes.join(" "))}
          onClose={() => {
            setOpenMail(null);
            setMaterialDoNauki([]);
            setZrodla([]);
            setZlecenia([]);
          }}
          onSaved={async (loadId, externalIds) => {
            await setStatus(openMail.id, "accepted");
            // Załącznik maila JUŻ leży w Storage (bucket `order-emails`, zapisał go `mail-poll`) —
            // podpinamy istniejący plik do zlecenia zamiast kopiować go drugi raz. Dzięki temu
            // zlecenie z maila ma swoje oryginały tak samo jak zlecenie wgrane ręcznie.
            //
            // Podpinamy TYLKO dokumenty tego zlecenia (`externalIds`): przy mailu z kilkoma
            // zleceniami dopięcie wszystkich załączników do każdego z nich byłoby bałaganem, którego
            // z Zestawienia już nie da się odkręcić.
            const { data } = await supabase
              .from("email_attachments")
              .select("*")
              .eq("email_message_id", openMail.id);
            const wybrane = (data ?? []).filter((a) => externalIds.length === 0 || externalIds.includes(String(a.id)));
            for (const attachment of wybrane as EmailAttachment[]) {
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
            // Nic tu nie czyścimy: przy mailu z kilkoma zleceniami okno zostaje otwarte i wczytuje
            // następne, a podgląd źródła musi mu dalej towarzyszyć. Sprzątanie robi onClose.
          }}
        />
      )}
    </>
  );
}
