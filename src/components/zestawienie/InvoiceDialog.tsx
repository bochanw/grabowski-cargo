"use client";

import { useState } from "react";
import { useUpdateLoad } from "@/hooks/useLoads";
import { createInvoice, type CreatedInvoice } from "@/lib/supabase/createInvoice";
import { buildInvoiceTitle, type ExportOrigin } from "@/lib/invoice/invoiceTitle";
import type { Contractor } from "@/types/contractor";
import type { Load } from "@/types/load";

const REASON_MESSAGES: Record<string, string> = {
  not_configured: "Fakturownia nie jest jeszcze skonfigurowana — brak sekretów FAKTUROWNIA_SUBDOMAIN / FAKTUROWNIA_API_TOKEN w projekcie Supabase.",
  not_deployed: "Funkcja fakturownia-create-invoice nie jest jeszcze wdrożona na projekcie Supabase.",
  unauthorized: "Sesja wygasła — zaloguj się ponownie.",
  network: "Nie udało się połączyć z serwerem — sprawdź połączenie i spróbuj ponownie.",
};

// Wystawienie faktury w Fakturowni dla jednego zlecenia. Wszystko, co idzie na fakturę, jest
// widoczne i edytowalne PRZED wysłaniem (tytuł, kwota, termin) — nic nie wychodzi bez kliknięcia.
export function InvoiceDialog({
  load,
  contractor,
  onClose,
}: {
  load: Load;
  contractor: Contractor | null;
  onClose: () => void;
}) {
  const updateLoad = useUpdateLoad();
  const [exportOrigin, setExportOrigin] = useState<ExportOrigin>("poimport");
  const [title, setTitle] = useState(() => buildInvoiceTitle(load, "poimport"));
  const [titleTouched, setTitleTouched] = useState(false);
  const [amount, setAmount] = useState<number | null>(load.invoice_amount);
  const [paymentTermsDays, setPaymentTermsDays] = useState<number | null>(
    load.payment_terms_days ?? contractor?.payment_terms_days ?? null
  );
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvoice | null>(null);

  const alreadyIssued = load.fakturownia_invoice_id !== null && load.fakturownia_invoice_id !== undefined;
  const buyerStreet = contractor
    ? [contractor.address, [contractor.postal_code, contractor.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : "";
  const blockers: string[] = [];
  if (!contractor) blockers.push("Zlecenie nie ma kontrahenta — ustaw go w kolumnie „Kontrahent” (blok Fakturowanie).");
  if (contractor && !contractor.nip && !contractor.vat_eu) blockers.push(`Kontrahent ${contractor.name} nie ma NIP-u ani VAT-EU — uzupełnij w „Kontrahenci”.`);
  if (!amount || amount <= 0) blockers.push("Brak dodatniej kwoty (Stawka / Kwota w zleceniu).");
  if (!title.trim()) blockers.push("Tytuł pozycji nie może być pusty.");

  function changeOrigin(origin: ExportOrigin) {
    setExportOrigin(origin);
    if (!titleTouched) setTitle(buildInvoiceTitle(load, origin));
  }

  async function handleSend() {
    if (!contractor || blockers.length > 0 || amount === null) return;
    setIsSending(true);
    setError(null);
    const result = await createInvoice({
      loadId: load.id,
      orderNumber: load.order_number ?? "",
      title: title.trim(),
      amount,
      currency: "PLN",
      paymentTermsDays,
      paymentTermsNote: load.payment_terms_note ?? contractor.payment_terms_note,
      sellDate: load.secondary_date ?? load.load_date,
      buyer: { name: contractor.name, nip: contractor.nip, vatEu: contractor.vat_eu, street: buyerStreet || null, email: contractor.email },
    });
    setIsSending(false);
    if (!result.ok) {
      setError(REASON_MESSAGES[result.reason] ?? result.error);
      return;
    }
    setCreated(result.invoice);
    const saveError = await updateLoad(load.id, {
      fakturownia_invoice_id: result.invoice.id,
      invoice_number: result.invoice.number || null,
      invoice_url: result.invoice.viewUrl,
      invoice_issued_at: result.invoice.issueDate,
      invoice_payment_date: result.invoice.paymentTo,
      invoice_amount: amount,
    });
    if (saveError) setError(`Faktura wystawiona (${result.invoice.number}), ale nie udało się zapisać jej numeru przy zleceniu: ${saveError}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Faktura — zlecenie {load.order_number ?? ""}
          </h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
          {(alreadyIssued || created) && (
            <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
              Faktura wystawiona: <strong>{created?.number || load.invoice_number || "(bez numeru)"}</strong>
              {(created?.viewUrl || load.invoice_url) && (
                <>
                  {" — "}
                  <a href={created?.viewUrl || load.invoice_url || "#"} target="_blank" rel="noreferrer" className="underline">
                    otwórz w Fakturowni
                  </a>
                </>
              )}
            </p>
          )}
          {error && (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}
          {!alreadyIssued && !created && blockers.map((b) => (
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

          {!alreadyIssued && !created && (
            <div className="grid grid-cols-2 gap-3">
              {load.direction === "E" && (
                <Field label="Skąd pusty kontener (eksport)">
                  <select className={inputClass} value={exportOrigin} onChange={(e) => changeOrigin(e.target.value as ExportOrigin)}>
                    <option value="poimport">Poimport</option>
                    <option value="depot">z Depotu</option>
                  </select>
                </Field>
              )}
              <Field label="Tytuł pozycji na fakturze" full>
                <textarea
                  className={inputClass}
                  rows={2}
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleTouched(true);
                  }}
                />
              </Field>
              <Field label="Kwota brutto (PLN)">
                <input type="number" step="0.01" className={inputClass} value={amount ?? ""} onChange={(e) => setAmount(e.target.value === "" ? null : Number(e.target.value))} />
              </Field>
              <Field label="Termin płatności (dni od wystawienia)">
                <input type="number" className={inputClass} value={paymentTermsDays ?? ""} onChange={(e) => setPaymentTermsDays(e.target.value === "" ? null : Number(e.target.value))} />
              </Field>
              <p className="col-span-2 text-xs text-zinc-500">
                Data wystawienia: dziś. Data sprzedaży: {load.secondary_date ?? load.load_date ?? "dziś"}. VAT: 23% (krajowy) / np (VAT-EU).
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
            {created || alreadyIssued ? "Zamknij" : "Anuluj"}
          </button>
          {!alreadyIssued && !created && (
            <button
              type="button"
              disabled={isSending || blockers.length > 0}
              onClick={handleSend}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {isSending ? "Wystawianie…" : "Wystaw fakturę w Fakturowni"}
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
    <label className={`flex flex-col gap-0.5 text-xs text-zinc-600 dark:text-zinc-400 ${full ? "col-span-2" : ""}`}>
      {label}
      {children}
    </label>
  );
}
