"use client";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { extractPdfText } from "@/lib/pdf/extractPdfText";
import { matchKnownTemplate } from "@/lib/orderTemplates";
import { EMPTY_PARSED_ORDER, type ParsedOrder } from "@/types/parsedOrder";
import type { Direction } from "@/types/load";

type Stage = "pick" | "parsing" | "review" | "saving";

export function ImportOrderDialog({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<Stage>("pick");
  const [form, setForm] = useState<ParsedOrder>(EMPTY_PARSED_ORDER);
  const [carrierName, setCarrierName] = useState("Grabowski Mariusz Sp. z o.o.");
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(file: File | undefined) {
    if (!file) return;
    setStage("parsing");
    setNotice(null);
    setWarning(null);

    let text: string;
    try {
      text = await extractPdfText(file);
    } catch (e) {
      setWarning(`Nie udało się odczytać pliku PDF: ${e instanceof Error ? e.message : String(e)}`);
      setStage("review");
      return;
    }

    // Rozpoznawanie po znanych szablonach klientów — na razie JEDYNA metoda (bez wysyłania
    // pliku do modelu). Nierozpoznany PDF nie jest błędem: appka po prostu otwiera pusty
    // formularz do ręcznego wypełnienia, zamiast czegokolwiek zgadywać.
    const match = matchKnownTemplate(text);
    if (match) {
      setForm(match.parsed);
      setNotice(`Rozpoznano szablon: ${match.name}. Sprawdź pola przed zapisem.`);
      if (match.parsed.rate_currency && match.parsed.rate_currency.toUpperCase() !== "PLN") {
        setWarning(`Uwaga: dokument podaje stawkę w ${match.parsed.rate_currency}, appka dziś zakłada PLN — sprawdź kwotę.`);
      }
    } else {
      setForm(EMPTY_PARSED_ORDER);
      setNotice("Nie rozpoznano znanego szablonu zlecenia — uzupełnij pola ręcznie poniżej. Z czasem dopiszemy więcej szablonów.");
    }
    setStage("review");
  }

  function updateField<K extends keyof ParsedOrder>(key: K, value: ParsedOrder[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (form.direction !== "I" && form.direction !== "E") return;
    setStage("saving");
    setSaveError(null);

    const { error } = await supabase.from("loads").insert({
      order_number: form.order_number || null,
      forwarder: form.forwarder || null,
      direction: form.direction as Direction,
      container_number: form.container_number || null,
      container_size: form.container_size || null,
      shipping_line: form.shipping_line || null,
      company_name: form.company_name || null,
      address: form.address || null,
      city: form.city || null,
      load_date: form.load_date || null,
      secondary_date: form.delivery_date || null,
      time_of_day: form.delivery_time || null,
      customs_status: form.customs_location_or_status || null,
      invoice_amount: form.rate_amount,
      payment_terms_days: form.payment_terms_days,
      payment_terms_note: form.payment_terms_note || null,
      notes: form.notes || null,
      carrier_name: carrierName || null,
    });

    if (error) {
      setSaveError(error.message);
      setStage("review");
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Importuj zlecenie (PDF)
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            aria-label="Zamknij"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {stage === "pick" && (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Wybierz plik PDF ze zleceniem spedycyjnym — pola spróbujemy wyciągnąć automatycznie.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                onChange={(e) => handleFileChange(e.target.files?.[0])}
                className="text-sm text-zinc-700 dark:text-zinc-300"
              />
            </div>
          )}

          {stage === "parsing" && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-zinc-500">
              <span>Odczytywanie zlecenia…</span>
            </div>
          )}

          {(stage === "review" || stage === "saving") && (
            <div className="flex flex-col gap-3">
              {notice && (
                <p className="rounded border border-blue-300 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
                  {notice}
                </p>
              )}
              {warning && (
                <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  {warning}
                </p>
              )}
              {saveError && (
                <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                  Nie udało się zapisać: {saveError}
                </p>
              )}
              <p className="text-xs text-zinc-500">
                Sprawdź i popraw pola przed zapisem — appka niczego nie zapisuje bez Twojej zgody.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Numer zlecenia">
                  <input className={inputClass} value={form.order_number} onChange={(e) => updateField("order_number", e.target.value)} />
                </Field>
                <Field label="Spedycja (zleceniodawca)">
                  <input className={inputClass} value={form.forwarder} onChange={(e) => updateField("forwarder", e.target.value)} />
                </Field>

                <Field label="Kierunek *">
                  <select
                    className={inputClass}
                    value={form.direction}
                    onChange={(e) => updateField("direction", e.target.value as ParsedOrder["direction"])}
                  >
                    <option value="">— wybierz —</option>
                    <option value="I">Import</option>
                    <option value="E">Eksport</option>
                  </select>
                </Field>
                <Field label="Numer kontenera">
                  <input className={inputClass} value={form.container_number} onChange={(e) => updateField("container_number", e.target.value)} />
                </Field>

                <Field label="Wielkość kontenera">
                  <input className={inputClass} value={form.container_size} onChange={(e) => updateField("container_size", e.target.value)} placeholder="np. 20DV" />
                </Field>
                <Field label="Gestia / linia">
                  <input className={inputClass} value={form.shipping_line} onChange={(e) => updateField("shipping_line", e.target.value)} placeholder="np. ONE" />
                </Field>

                <Field label="Firma (rozładunek)">
                  <input className={inputClass} value={form.company_name} onChange={(e) => updateField("company_name", e.target.value)} />
                </Field>
                <Field label="Miejscowość">
                  <input className={inputClass} value={form.city} onChange={(e) => updateField("city", e.target.value)} />
                </Field>

                <Field label="Adres" full>
                  <input className={inputClass} value={form.address} onChange={(e) => updateField("address", e.target.value)} />
                </Field>

                <Field label="Data załadunku">
                  <input type="date" className={inputClass} value={form.load_date} onChange={(e) => updateField("load_date", e.target.value)} />
                </Field>
                <Field label="Data rozładunku">
                  <input type="date" className={inputClass} value={form.delivery_date} onChange={(e) => updateField("delivery_date", e.target.value)} />
                </Field>

                <Field label="Godzina rozładunku">
                  <input className={inputClass} value={form.delivery_time} onChange={(e) => updateField("delivery_time", e.target.value)} placeholder="np. 07:00" />
                </Field>
                <Field label="Miejsce/status odprawy celnej">
                  <input className={inputClass} value={form.customs_location_or_status} onChange={(e) => updateField("customs_location_or_status", e.target.value)} />
                </Field>

                <Field label="Stawka (PLN)">
                  <input
                    type="number"
                    step="0.01"
                    className={inputClass}
                    value={form.rate_amount ?? ""}
                    onChange={(e) => updateField("rate_amount", e.target.value === "" ? null : Number(e.target.value))}
                  />
                </Field>
                <Field label="Przewoźnik">
                  <input className={inputClass} value={carrierName} onChange={(e) => setCarrierName(e.target.value)} />
                </Field>

                <Field label="Termin płatności (dni)">
                  <input
                    type="number"
                    className={inputClass}
                    value={form.payment_terms_days ?? ""}
                    onChange={(e) => updateField("payment_terms_days", e.target.value === "" ? null : Number(e.target.value))}
                  />
                </Field>
                <Field label="Warunek płatności">
                  <input className={inputClass} value={form.payment_terms_note} onChange={(e) => updateField("payment_terms_note", e.target.value)} placeholder="np. od wpływu faktury" />
                </Field>

                <Field label="Uwagi" full>
                  <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => updateField("notes", e.target.value)} />
                </Field>
              </div>
            </div>
          )}
        </div>

        {(stage === "review" || stage === "saving") && (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            >
              Anuluj
            </button>
            <button
              type="button"
              disabled={stage === "saving" || (form.direction !== "I" && form.direction !== "E")}
              onClick={handleSave}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {stage === "saving" ? "Zapisywanie…" : "Zapisz zlecenie"}
            </button>
          </div>
        )}
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
