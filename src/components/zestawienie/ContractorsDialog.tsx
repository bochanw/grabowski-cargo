"use client";

import { useState } from "react";
import { useContractors, useDeleteContractor, useSaveContractor } from "@/hooks/useContractors";
import {
  BAF_INVOICE_MODE_LABELS,
  bafInvoiceMode,
  EMPTY_CONTRACTOR,
  type BafInvoiceMode,
  type Contractor,
  type ContractorInput,
} from "@/types/contractor";

// Kontrahenci = spedytorzy/zleceniodawcy z danymi do faktury (Fakturownia) i domyślnym terminem
// płatności. Import dopasowuje spedytora z PDF-a po nazwie/aliasach i podstawia termin, gdy
// dokument go nie podaje. Jedno okno: lista po lewej, formularz po prawej.
export function ContractorsDialog({ onClose }: { onClose: () => void }) {
  const { data: contractors = [], isLoading, isError, error } = useContractors();
  const saveContractor = useSaveContractor();
  const deleteContractor = useDeleteContractor();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<ContractorInput>(EMPTY_CONTRACTOR);
  const [aliasesText, setAliasesText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  function startNew() {
    setEditingId("new");
    setForm(EMPTY_CONTRACTOR);
    setAliasesText("");
    setMessage(null);
  }

  function startEdit(contractor: Contractor) {
    const { id: _id, created_at: _c, updated_at: _u, ...input } = contractor;
    void _id; void _c; void _u;
    setEditingId(contractor.id);
    setForm(input);
    setAliasesText(contractor.aliases.join(", "));
    setMessage(null);
  }

  function update<K extends keyof ContractorInput>(key: K, value: ContractorInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const text = (value: string) => (value.trim() === "" ? null : value.trim());

  async function handleSave() {
    if (!form.name.trim()) {
      setMessage("Nazwa kontrahenta jest wymagana.");
      return;
    }
    setIsSaving(true);
    const input: ContractorInput = {
      ...form,
      name: form.name.trim(),
      aliases: aliasesText.split(",").map((a) => a.trim()).filter(Boolean),
    };
    const err = await saveContractor(input, editingId === "new" ? undefined : editingId ?? undefined);
    setIsSaving(false);
    if (err) {
      setMessage(`Nie udało się zapisać: ${err}`);
      return;
    }
    setEditingId(null);
    setMessage("Zapisano.");
  }

  async function handleDelete(contractor: Contractor) {
    if (!window.confirm(`Usunąć kontrahenta ${contractor.name}? Zlecenia zostaną, tylko stracą powiązanie.`)) return;
    const err = await deleteContractor(contractor.id);
    setMessage(err ? `Nie udało się usunąć: ${err}` : "Usunięto.");
    if (!err && editingId === contractor.id) setEditingId(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Kontrahenci</h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-72 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
            <div className="border-b border-zinc-200 p-2 dark:border-zinc-800">
              <button type="button" onClick={startNew} className="w-full rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                + Nowy kontrahent
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {isLoading && <p className="p-3 text-xs text-zinc-500">Wczytywanie…</p>}
              {isError && (
                <p className="p-3 text-xs text-red-600">Nie udało się wczytać: {error instanceof Error ? error.message : String(error)}</p>
              )}
              {!isLoading && !isError && contractors.length === 0 && (
                <p className="p-3 text-xs text-zinc-500">Brak kontrahentów — dodaj pierwszego.</p>
              )}
              {contractors.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => startEdit(c)}
                  className={`block w-full border-b border-zinc-100 px-3 py-2 text-left text-xs hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900 ${
                    editingId === c.id ? "bg-zinc-100 dark:bg-zinc-900" : ""
                  }`}
                >
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{c.name}</div>
                  <div className="text-zinc-500">
                    {c.nip ? `NIP ${c.nip}` : "brak NIP"}
                    {c.payment_terms_days !== null ? ` · ${c.payment_terms_days} dni` : ""}
                    {bafInvoiceMode(c) === "separate" ? " · BAF osobną pozycją" : ""}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {message && <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-400">{message}</p>}
            {editingId === null ? (
              <p className="text-sm text-zinc-500">Wybierz kontrahenta z listy albo dodaj nowego.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nazwa (na fakturze) *" full>
                  <input className={inputClass} value={form.name} onChange={(e) => update("name", e.target.value)} />
                </Field>
                <Field label="Inne nazwy z dokumentów (po przecinku)" full>
                  <input className={inputClass} value={aliasesText} onChange={(e) => setAliasesText(e.target.value)} placeholder="np. Q4Road Sp. z o.o, Q4ROAD" />
                </Field>
                <Field label="NIP">
                  <input className={inputClass} value={form.nip ?? ""} onChange={(e) => update("nip", text(e.target.value))} placeholder="same cyfry" />
                </Field>
                <Field label="VAT-EU (kontrahent zagraniczny)">
                  <input className={inputClass} value={form.vat_eu ?? ""} onChange={(e) => update("vat_eu", text(e.target.value))} />
                </Field>
                <Field label="Ulica i numer" full>
                  <input className={inputClass} value={form.address ?? ""} onChange={(e) => update("address", text(e.target.value))} />
                </Field>
                <Field label="Kod pocztowy">
                  <input className={inputClass} value={form.postal_code ?? ""} onChange={(e) => update("postal_code", text(e.target.value))} />
                </Field>
                <Field label="Miejscowość">
                  <input className={inputClass} value={form.city ?? ""} onChange={(e) => update("city", text(e.target.value))} />
                </Field>
                <Field label="E-mail do faktur" full>
                  <input type="email" className={inputClass} value={form.email ?? ""} onChange={(e) => update("email", text(e.target.value))} />
                </Field>
                <Field label="Termin płatności (dni)">
                  <input
                    type="number"
                    className={inputClass}
                    value={form.payment_terms_days ?? ""}
                    onChange={(e) => update("payment_terms_days", e.target.value === "" ? null : Number(e.target.value))}
                  />
                </Field>
                <Field label="Warunek płatności">
                  <input className={inputClass} value={form.payment_terms_note ?? ""} onChange={(e) => update("payment_terms_note", text(e.target.value))} placeholder="np. od wpływu faktury i listu przewozowego" />
                </Field>
                {/* BAF na fakturze jest cechą kontrahenta, nie zlecenia — właściciel: "będziemy
                    wypychać do faktur albo stawkę z BAF razem, albo BAF jako oddzielną pozycję
                    — do konfiguracji via klient". Rozbicie stawki liczy się przy zleceniu zawsze;
                    to ustawienie decyduje tylko, ile pozycji zobaczy kontrahent na fakturze. */}
                <Field label="BAF (dodatek paliwowy) na fakturze" full>
                  <select
                    className={inputClass}
                    value={bafInvoiceMode(form)}
                    onChange={(e) => update("baf_invoice_mode", e.target.value as BafInvoiceMode)}
                  >
                    {(Object.keys(BAF_INVOICE_MODE_LABELS) as BafInvoiceMode[]).map((mode) => (
                      <option key={mode} value={mode}>
                        {BAF_INVOICE_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Uwagi" full>
                  <textarea className={inputClass} rows={2} value={form.notes ?? ""} onChange={(e) => update("notes", text(e.target.value))} />
                </Field>
                <div className="col-span-2 flex items-center justify-between pt-2">
                  {editingId !== "new" ? (
                    <button
                      type="button"
                      onClick={() => {
                        const current = contractors.find((c) => c.id === editingId);
                        if (current) handleDelete(current);
                      }}
                      className="rounded border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
                    >
                      Usuń kontrahenta
                    </button>
                  ) : (
                    <span />
                  )}
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setEditingId(null)} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                      Anuluj
                    </button>
                    <button type="button" disabled={isSaving} onClick={handleSave} className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
                      {isSaving ? "Zapisywanie…" : "Zapisz"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
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
