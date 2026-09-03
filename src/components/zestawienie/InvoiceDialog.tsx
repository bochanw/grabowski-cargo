"use client";

import { useState } from "react";
import { useUpdateLoad } from "@/hooks/useLoads";
import { createInvoice, type CreatedInvoice } from "@/lib/supabase/createInvoice";
import { buildBafPositionTitle, buildInvoiceTitle, type ExportOrigin } from "@/lib/invoice/invoiceTitle";
import { bafInvoiceMode, type BafInvoiceMode, type Contractor } from "@/types/contractor";
import type { Load } from "@/types/load";

const REASON_MESSAGES: Record<string, string> = {
  not_configured: "Fakturownia nie jest jeszcze skonfigurowana — brak sekretów FAKTUROWNIA_SUBDOMAIN / FAKTUROWNIA_API_TOKEN w projekcie Supabase.",
  not_deployed: "Funkcja fakturownia-create-invoice nie jest jeszcze wdrożona na projekcie Supabase.",
  unauthorized: "Sesja wygasła — zaloguj się ponownie.",
  network: "Nie udało się połączyć z serwerem — sprawdź połączenie i spróbuj ponownie.",
};

interface PositionState {
  /** Jedno zlecenie może dać DWIE pozycje (fracht + BAF), więc identyfikuje je para id+rodzaj. */
  key: string;
  loadId: string;
  kind: "freight" | "baf";
  title: string;
  titleTouched: boolean;
  amountNet: number | null;
  origin: ExportOrigin;
  isExport: boolean;
  orderNumber: string;
}

/**
 * Pozycje faktury: jedna na zlecenie, ALBO dwie (fracht + dodatek paliwowy), gdy kontrahent ma
 * ustawione `baf_invoice_mode = 'separate'` (właściciel: "albo stawkę z BAF razem, albo BAF jako
 * oddzielną pozycję — do konfiguracji via klient"). Rozbicie stawki siedzi już przy zleceniu
 * (freight_base_amount / baf_amount, migracja 0013) — tu tylko decydujemy, ile pozycji z niego zrobić.
 */
function initialPositions(loads: Load[], mode: BafInvoiceMode): PositionState[] {
  return loads.flatMap((load) => {
    const common = {
      loadId: load.id,
      titleTouched: false,
      origin: "poimport" as ExportOrigin,
      isExport: load.direction === "E",
      orderNumber: load.order_number ?? "",
    };
    const splitOut = mode === "separate" && load.baf_amount !== null && load.freight_base_amount !== null;
    if (splitOut) {
      return [
        { ...common, key: `${load.id}:freight`, kind: "freight" as const, title: buildInvoiceTitle(load, "poimport"), amountNet: load.freight_base_amount },
        { ...common, key: `${load.id}:baf`, kind: "baf" as const, title: buildBafPositionTitle(load), amountNet: load.baf_amount },
      ];
    }
    return [
      {
        ...common,
        key: `${load.id}:freight`,
        kind: "freight" as const,
        title: buildInvoiceTitle(load, "poimport"),
        // Kwota RAZEM z BAF-em: total_amount, a dla zleceń sprzed rozbicia stawki — invoice_amount.
        amountNet: load.total_amount ?? load.invoice_amount,
      },
    ];
  });
}

// Data sprzedaży: przy kilku ładunkach z różnych dni bierzemy NAJPÓŹNIEJSZĄ jako propozycję —
// dyspozytor i tak ją wybiera ręcznie (właściciel: "potrzebuję możliwość wybrania daty sprzedaży").
function defaultSellDate(loads: Load[]): string {
  const dates = loads.map((l) => l.secondary_date ?? l.load_date).filter((d): d is string => Boolean(d)).sort();
  return dates.length > 0 ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
}

/**
 * Wystawienie faktury w Fakturowni dla JEDNEGO lub KILKU zleceń (jedna pozycja = jedno zlecenie).
 * Kwoty są NETTO — Fakturownia dolicza VAT. Wszystko widoczne i edytowalne PRZED wysłaniem.
 */
export function InvoiceDialog({
  loads,
  contractors,
  onClose,
}: {
  loads: Load[];
  contractors: Contractor[];
  onClose: () => void;
}) {
  const updateLoad = useUpdateLoad();
  // Kontrahent (a z nim sposób pokazania BAF-u) jest znany z propsów już przy pierwszym renderze —
  // liczymy go PRZED stanem pozycji, bo od niego zależy, ile tych pozycji w ogóle powstanie.
  const contractorIds = Array.from(new Set(loads.map((l) => l.contractor_id)));
  const contractor = contractorIds.length === 1 ? contractors.find((c) => c.id === contractorIds[0]) ?? null : null;
  const bafMode = bafInvoiceMode(contractor);
  const [positions, setPositions] = useState<PositionState[]>(() => initialPositions(loads, bafMode));
  const [sellDate, setSellDate] = useState(() => defaultSellDate(loads));
  const [paymentTermsDays, setPaymentTermsDays] = useState<number | null>(
    loads[0]?.payment_terms_days ?? null
  );
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvoice | null>(null);

  const byLoadId = new Map(loads.map((l) => [l.id, l]));
  const alreadyIssued = loads.filter((l) => l.fakturownia_invoice_id);
  const totalNet = positions.reduce((sum, p) => sum + (p.amountNet ?? 0), 0);

  if (paymentTermsDays === null && contractor?.payment_terms_days != null && !isSending && !created) {
    // Kontrahent ma domyślny termin, zlecenie nie — podstawiamy raz, przy pierwszym renderze.
    setPaymentTermsDays(contractor.payment_terms_days);
  }

  const buyerStreet = contractor
    ? [contractor.address, [contractor.postal_code, contractor.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : "";

  const blockers: string[] = [];
  if (contractorIds.length > 1) blockers.push("Zaznaczone zlecenia mają różnych kontrahentów — faktura zbiorcza musi dotyczyć jednego kontrahenta.");
  if (!contractor) blockers.push("Zlecenie nie ma kontrahenta — ustaw go w kolumnie „Kontrahent” (blok Fakturowanie).");
  if (contractor && !contractor.nip && !contractor.vat_eu) blockers.push(`Kontrahent ${contractor.name} nie ma NIP-u ani VAT-EU — uzupełnij w „Kontrahenci”.`);
  if (positions.some((p) => !p.amountNet || p.amountNet <= 0)) blockers.push("Każda pozycja musi mieć dodatnią kwotę netto.");
  if (positions.some((p) => !p.title.trim())) blockers.push("Każda pozycja musi mieć tytuł.");
  if (alreadyIssued.length > 0) blockers.push(`Zlecenia z już wystawioną fakturą: ${alreadyIssued.map((l) => l.order_number ?? l.id).join(", ")} — odznacz je.`);

  function updatePosition(key: string, patch: Partial<PositionState>) {
    setPositions((prev) =>
      prev.map((p) => {
        if (p.key !== key) return p;
        const next = { ...p, ...patch };
        // Zmiana "skąd pusty" (eksport) przelicza tytuł, dopóki dyspozytor go ręcznie nie poprawił.
        // Tytuł pozycji BAF nie zawiera trasy, więc jego nie ma po co przeliczać.
        if (patch.origin && !next.titleTouched && p.kind === "freight") {
          const load = byLoadId.get(p.loadId);
          if (load) next.title = buildInvoiceTitle(load, patch.origin);
        }
        return next;
      })
    );
  }

  async function handleSend() {
    if (!contractor || blockers.length > 0) return;
    setIsSending(true);
    setError(null);
    const result = await createInvoice({
      loadIds: positions.map((p) => p.loadId),
      positions: positions.map((p) => ({ title: p.title.trim(), amountNet: p.amountNet as number })),
      currency: "PLN",
      paymentTermsDays,
      paymentTermsNote: loads[0]?.payment_terms_note ?? contractor.payment_terms_note,
      sellDate,
      buyer: { name: contractor.name, nip: contractor.nip, vatEu: contractor.vat_eu, street: buyerStreet || null, email: contractor.email },
    });
    setIsSending(false);
    if (!result.ok) {
      setError(REASON_MESSAGES[result.reason] ?? result.error);
      return;
    }
    setCreated(result.invoice);

    // Faktura wystawiona — podpinamy ją do KAŻDEGO zlecenia z osobna. Kwota przy zleceniu to SUMA
    // jego pozycji: przy rozbitym BAF-ie zlecenie ma na fakturze dwie pozycje, a zafakturowane
    // zostało i tak jedno zlecenie na pełną kwotę.
    const amountByLoad = new Map<string, number>();
    const orderNumberByLoad = new Map<string, string>();
    for (const position of positions) {
      amountByLoad.set(position.loadId, (amountByLoad.get(position.loadId) ?? 0) + (position.amountNet ?? 0));
      orderNumberByLoad.set(position.loadId, position.orderNumber);
    }
    const failures: string[] = [];
    for (const [loadId, amountNet] of amountByLoad) {
      const saveError = await updateLoad(loadId, {
        fakturownia_invoice_id: result.invoice.id,
        invoice_number: result.invoice.number || null,
        invoice_url: result.invoice.viewUrl,
        invoice_issued_at: result.invoice.issueDate,
        invoice_payment_date: result.invoice.paymentTo,
        invoice_amount: amountNet,
      });
      if (saveError) failures.push(`${orderNumberByLoad.get(loadId) || loadId}: ${saveError}`);
    }
    if (failures.length > 0) {
      setError(`Faktura wystawiona (${result.invoice.number}), ale nie udało się zapisać jej przy zleceniach: ${failures.join("; ")}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            {loads.length === 1 ? `Faktura — zlecenie ${loads[0].order_number ?? ""}` : `Faktura zbiorcza — ${loads.length} zleceń`}
          </h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
          {created && (
            <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
              Faktura wystawiona: <strong>{created.number || "(bez numeru)"}</strong>
              {" — "}
              <a href={created.viewUrl} target="_blank" rel="noreferrer" className="underline">
                otwórz w Fakturowni
              </a>
            </p>
          )}
          {error && (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}
          {!created && blockers.map((b) => (
            <p key={b} className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              {b}
            </p>
          ))}

          <div className="rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
            <div className="mb-1 font-medium text-zinc-700 dark:text-zinc-300">Nabywca (z „Kontrahenci”)</div>
            {contractor ? (
              <div className="text-zinc-600 dark:text-zinc-400">
                {contractor.name}
                {contractor.nip ? ` · NIP ${contractor.nip}` : ""}
                {contractor.vat_eu ? ` · VAT-EU ${contractor.vat_eu}` : ""}
                {buyerStreet ? ` · ${buyerStreet}` : ""}
                {contractor.email ? ` · ${contractor.email}` : " · brak e-maila (Fakturownia nie wyśle faktury mailem)"}
              </div>
            ) : (
              <div className="text-zinc-500">—</div>
            )}
          </div>

          {!created && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Data sprzedaży">
                  <input type="date" className={inputClass} value={sellDate} onChange={(e) => setSellDate(e.target.value)} />
                </Field>
                <Field label="Termin płatności (dni od wystawienia)">
                  <input type="number" className={inputClass} value={paymentTermsDays ?? ""} onChange={(e) => setPaymentTermsDays(e.target.value === "" ? null : Number(e.target.value))} />
                </Field>
                <Field label="Razem netto (PLN)">
                  <input readOnly className={`${inputClass} bg-zinc-50 dark:bg-zinc-900`} value={totalNet.toLocaleString("pl-PL", { minimumFractionDigits: 2 })} />
                </Field>
              </div>

              <div className="flex flex-col gap-3">
                {positions.map((position, index) => (
                  <div key={position.key} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                      Pozycja {index + 1} — zlecenie {position.orderNumber || "(bez numeru)"}
                      {position.kind === "baf" ? " · dodatek paliwowy" : ""}
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <Field label="Tytuł pozycji na fakturze" full>
                        <textarea
                          className={inputClass}
                          rows={2}
                          value={position.title}
                          onChange={(e) => updatePosition(position.key, { title: e.target.value, titleTouched: true })}
                        />
                      </Field>
                      <Field label="Kwota netto (PLN)">
                        <input
                          type="number"
                          step="0.01"
                          className={inputClass}
                          value={position.amountNet ?? ""}
                          onChange={(e) => updatePosition(position.key, { amountNet: e.target.value === "" ? null : Number(e.target.value) })}
                        />
                      </Field>
                      {position.isExport && position.kind === "freight" && (
                        <Field label="Skąd pusty kontener (eksport)">
                          <select className={inputClass} value={position.origin} onChange={(e) => updatePosition(position.key, { origin: e.target.value as ExportOrigin })}>
                            <option value="poimport">Poimport</option>
                            <option value="depot">z Depotu</option>
                          </select>
                        </Field>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-xs text-zinc-500">
                Kwoty są NETTO — Fakturownia doliczy VAT (23% krajowy / „np” przy VAT-EU). Data wystawienia: dziś.
              </p>
              {loads.some((load) => load.baf_amount !== null) && (
                <p className="text-xs text-zinc-500">
                  {bafMode === "separate"
                    ? "Dodatek paliwowy (BAF) idzie osobną pozycją — tak ma ustawiony ten kontrahent."
                    : "Dodatek paliwowy (BAF) jest wliczony w kwotę pozycji — tak ma ustawiony ten kontrahent."}
                  {" Zmiana ustawienia: „Kontrahenci” → „BAF na fakturze”."}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
            {created ? "Zamknij" : "Anuluj"}
          </button>
          {!created && (
            <button
              type="button"
              disabled={isSending || blockers.length > 0}
              onClick={handleSend}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {isSending ? "Wystawianie…" : `Wystaw fakturę (${totalNet.toLocaleString("pl-PL", { minimumFractionDigits: 2 })} netto)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const inputClass =
  "w-full rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-0.5 text-xs text-zinc-600 dark:text-zinc-400 ${full ? "col-span-3" : ""}`}>
      {label}
      {children}
    </label>
  );
}
