"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { extractPdfText } from "@/lib/pdf/extractPdfText";
import { matchKnownTemplate } from "@/lib/orderTemplates";
import { PICKUP_LOCATIONS } from "@/lib/orderTemplates/pickupLocations";
import { previousWorkingDay } from "@/lib/dates/workingDays";
import { EMPTY_FLEET, reconcileWithFleet, useFleet, withCurrentOption, type Fleet } from "@/lib/fleet/fleetStore";
import { useContractors } from "@/hooks/useContractors";
import { findContractorByName, type Contractor } from "@/types/contractor";
import { EMPTY_PARSED_ORDER, mergeParsedOrders, type ParsedOrder } from "@/types/parsedOrder";
import type { Direction, Load } from "@/types/load";

type Stage = "pick" | "parsing" | "review" | "saving";

const DEFAULT_CARRIER = "Grabowski Mariusz Sp. z o.o.";

// Ten sam formularz służy do importu (insert), dopięcia dokumentu do istniejącego zlecenia
// (update, wypełnia tylko puste pola) i — gdyby wrócił do UI — edycji "wszystkiego naraz".
function loadToForm(load: Load): ParsedOrder {
  return {
    order_number: load.order_number ?? "",
    forwarder: load.forwarder ?? "",
    direction: load.direction,
    container_number: load.container_number ?? "",
    container_size: load.container_size ?? "",
    shipping_line: load.shipping_line ?? "",
    company_name: load.company_name ?? "",
    address: load.address ?? "",
    city: load.city ?? "",
    load_date: load.load_date ?? "",
    delivery_date: load.secondary_date ?? "",
    delivery_time: load.time_of_day ?? "",
    customs_location_or_status: load.customs_status ?? "",
    rate_amount: load.invoice_amount,
    rate_currency: "",
    payment_terms_days: load.payment_terms_days,
    payment_terms_note: load.payment_terms_note ?? "",
    notes: load.notes ?? "",
    pickup_type: load.pickup_type ?? "",
    pin_booking: load.pin_booking ?? "",
    goods_name: load.goods_name ?? "",
    gross_weight: load.gross_weight ?? "",
    submitted_where: load.submitted_where ?? "",
    driver_name: load.driver_name ?? "",
    driver_id_number: load.driver_id_number ?? "",
    vehicle_plate: load.vehicle_plate ?? "",
    trailer_plate: load.trailer_plate ?? "",
    driver_phone: load.driver_phone ?? "",
  };
}

function formToRow(form: ParsedOrder, carrierName: string, contractorId: string) {
  return {
    contractor_id: contractorId || null,
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
    pickup_type: form.pickup_type || null,
    pin_booking: form.pin_booking || null,
    goods_name: form.goods_name || null,
    gross_weight: form.gross_weight || null,
    submitted_where: form.submitted_where || null,
    driver_name: form.driver_name || null,
    driver_id_number: form.driver_id_number || null,
    vehicle_plate: form.vehicle_plate || null,
    trailer_plate: form.trailer_plate || null,
    driver_phone: form.driver_phone || null,
  };
}

export function ImportOrderDialog({
  onClose,
  existingLoad,
  mode = existingLoad ? "edit" : "import",
  recentLoads = [],
}: {
  onClose: () => void;
  existingLoad?: Load;
  /** "attach" = dopnij kolejny dokument do istniejącego zlecenia (wypełnia tylko puste pola). */
  mode?: "import" | "edit" | "attach";
  /** Istniejące zlecenia od najnowszego — fallback "z poprzedniego zlecenia" dla pól floty. */
  recentLoads?: Load[];
}) {
  const { data: fleetData } = useFleet();
  const fleet: Fleet = fleetData ?? EMPTY_FLEET;
  const { data: contractors = [] } = useContractors();
  const [stage, setStage] = useState<Stage>(mode === "edit" ? "review" : "pick");
  const [form, setForm] = useState<ParsedOrder>(() => (existingLoad ? loadToForm(existingLoad) : EMPTY_PARSED_ORDER));
  const [carrierName, setCarrierName] = useState(existingLoad?.carrier_name ?? DEFAULT_CARRIER);
  const [contractorId, setContractorId] = useState(existingLoad?.contractor_id ?? "");
  const [recognized, setRecognized] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Jedno zlecenie to u klienta zwykle DWA dokumenty (zlecenie spedycyjne + list przewozowy dla
  // kierowcy) — można wgrać oba naraz albo dopiąć drugi później (także do już zapisanego zlecenia);
  // każdy kolejny dokument wypełnia TYLKO puste pola, więc nie nadpisuje ręcznych poprawek.
  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setStage("parsing");
    setSaveError(null);

    let merged = form;
    const newRecognized: string[] = [];
    const newWarnings: string[] = [];

    for (const file of files) {
      let text: string;
      try {
        text = await extractPdfText(file);
      } catch (e) {
        newWarnings.push(`${file.name}: nie udało się odczytać pliku PDF (${e instanceof Error ? e.message : String(e)}).`);
        continue;
      }
      // Rozpoznawanie po znanych szablonach klientów — na razie JEDYNA metoda (bez wysyłania
      // pliku do modelu). Nierozpoznany PDF nie jest błędem: pola zostają do ręcznego wypełnienia.
      const match = matchKnownTemplate(text);
      if (!match) {
        newWarnings.push(`${file.name}: nie rozpoznano znanego szablonu — uzupełnij pola z tego dokumentu ręcznie.`);
        continue;
      }
      if (merged.order_number && match.parsed.order_number && merged.order_number !== match.parsed.order_number) {
        newWarnings.push(`${file.name}: numer zlecenia ${match.parsed.order_number} różni się od już wczytanego ${merged.order_number} — sprawdź, czy to to samo zlecenie.`);
      }
      if (match.parsed.rate_currency && match.parsed.rate_currency.toUpperCase() !== "PLN") {
        newWarnings.push(`${file.name}: stawka w ${match.parsed.rate_currency}, appka dziś zakłada PLN — sprawdź kwotę.`);
      }
      merged = mergeParsedOrders(merged, match.parsed);
      newRecognized.push(match.name);
    }

    // Domyślna "Data" = dzień roboczy przed rozładunkiem/załadunkiem z dokumentu.
    if (!merged.load_date && merged.delivery_date) {
      merged = { ...merged, load_date: previousWorkingDay(merged.delivery_date) };
    }

    // Kierowca/pojazdy: dopasowanie do Panelu floty, fallback z poprzedniego zlecenia.
    const reconciled = reconcileWithFleet(merged, fleet, recentLoads);
    newWarnings.push(...reconciled.warnings);
    let order = reconciled.order;

    // Kontrahent: spedytor z dokumentu → skonfigurowany kontrahent (po nazwie/aliasach). Jego
    // domyślny termin płatności wchodzi TYLKO, gdy dokument go nie podał.
    if (!contractorId && order.forwarder) {
      const contractor = findContractorByName(contractors, order.forwarder);
      if (contractor) {
        setContractorId(contractor.id);
        order = applyContractorDefaults(order, contractor, newWarnings);
      } else if (contractors.length > 0) {
        newWarnings.push(`Spedytor "${order.forwarder}" nie pasuje do żadnego kontrahenta — wybierz z listy albo dodaj go w "Kontrahenci" (z nazwą z dokumentu jako aliasem).`);
      }
    }

    const allRecognized = [...recognized, ...newRecognized];
    setForm(order);
    setRecognized(allRecognized);
    setNotice(
      allRecognized.length > 0
        ? `Rozpoznano: ${allRecognized.join(", ")}. Sprawdź pola przed zapisem.`
        : "Nie rozpoznano znanego szablonu zlecenia — uzupełnij pola ręcznie poniżej. Z czasem dopiszemy więcej szablonów."
    );
    setWarnings((prev) => [...prev, ...newWarnings]);
    setStage("review");
  }

  function updateField<K extends keyof ParsedOrder>(key: K, value: ParsedOrder[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function selectContractor(id: string) {
    setContractorId(id);
    const contractor = contractors.find((c) => c.id === id);
    if (contractor) setForm((prev) => applyContractorDefaults(prev, contractor));
  }

  function selectDriver(name: string) {
    const driver = fleet.drivers.find((d) => d.name === name);
    setForm((prev) => ({
      ...prev,
      driver_name: name,
      driver_id_number: driver?.docNumber || prev.driver_id_number,
    }));
  }

  function selectTractor(plate: string) {
    const tractor = fleet.tractors.find((v) => v.plate === plate);
    setForm((prev) => ({
      ...prev,
      vehicle_plate: plate,
      trailer_plate: prev.trailer_plate || tractor?.assignedTrailerPlate || "",
    }));
  }

  async function handleSave() {
    if (form.direction !== "I" && form.direction !== "E") return;
    setStage("saving");
    setSaveError(null);

    const row = formToRow(form, carrierName, contractorId);
    const { error } = existingLoad
      ? await supabase.from("loads").update(row).eq("id", existingLoad.id)
      : await supabase.from("loads").insert(row);

    if (error) {
      setSaveError(error.message);
      setStage("review");
      return;
    }
    onClose();
  }

  const pickupOptions = withCurrentOption([...PICKUP_LOCATIONS], form.pickup_type);
  const driverOptions = withCurrentOption(fleet.drivers.map((d) => d.name), form.driver_name);
  const tractorOptions = withCurrentOption(fleet.tractors.map((v) => v.plate), form.vehicle_plate);
  const trailerOptions = withCurrentOption(fleet.trailers.map((v) => v.plate), form.trailer_plate);

  const title =
    mode === "attach"
      ? `Dopnij dokument do zlecenia ${existingLoad?.order_number ?? ""}`
      : mode === "edit"
        ? "Edytuj zlecenie"
        : "Importuj zlecenie (PDF)";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
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
              <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
                {mode === "attach"
                  ? "Wybierz brakujący dokument (np. list przewozowy) — wypełni tylko puste pola tego zlecenia."
                  : "Wybierz pliki PDF do zlecenia — zlecenie spedycyjne i/lub list przewozowy dla kierowcy (można zaznaczyć oba naraz). Pola spróbujemy wyciągnąć automatycznie."}
              </p>
              <input
                type="file"
                accept="application/pdf"
                multiple
                onChange={(e) => handleFiles(e.target.files)}
                className="text-sm text-zinc-700 dark:text-zinc-300"
              />
            </div>
          )}

          {stage === "parsing" && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-zinc-500">
              <span>Odczytywanie dokumentów…</span>
            </div>
          )}

          {(stage === "review" || stage === "saving") && (
            <div className="flex flex-col gap-3">
              {notice && (
                <p className="rounded border border-blue-300 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
                  {notice}
                </p>
              )}
              {warnings.map((warning) => (
                <p
                  key={warning}
                  className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                >
                  {warning}
                </p>
              ))}
              {saveError && (
                <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                  Nie udało się zapisać: {saveError}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                <span>Sprawdź i popraw pola przed zapisem — appka niczego nie zapisuje bez Twojej zgody.</span>
                <label className="flex items-center gap-2">
                  <span>Dopnij kolejny dokument:</span>
                  <input
                    type="file"
                    accept="application/pdf"
                    multiple
                    onChange={(e) => handleFiles(e.target.files)}
                    className="text-xs text-zinc-700 dark:text-zinc-300"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Numer zlecenia">
                  <input className={inputClass} value={form.order_number} onChange={(e) => updateField("order_number", e.target.value)} />
                </Field>
                <Field label="Spedycja (zleceniodawca)">
                  <input className={inputClass} value={form.forwarder} onChange={(e) => updateField("forwarder", e.target.value)} />
                </Field>

                <Field label="Kontrahent (dane do faktury)" full>
                  <select className={inputClass} value={contractorId} onChange={(e) => selectContractor(e.target.value)}>
                    <option value="">— brak / dodaj w „Kontrahenci” —</option>
                    {contractors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.nip ? ` · NIP ${c.nip}` : ""}
                        {c.payment_terms_days !== null ? ` · ${c.payment_terms_days} dni` : ""}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Kierunek *">
                  <select className={inputClass} value={form.direction} onChange={(e) => updateField("direction", e.target.value as ParsedOrder["direction"])}>
                    <option value="">— wybierz —</option>
                    <option value="I">Import</option>
                    <option value="E">Eksport</option>
                  </select>
                </Field>
                <Field label="Podjęcie (terminal)">
                  <select className={inputClass} value={form.pickup_type} onChange={(e) => updateField("pickup_type", e.target.value)}>
                    <option value="">— wybierz —</option>
                    {pickupOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>

                <Field label="Numer kontenera">
                  <input className={inputClass} value={form.container_number} onChange={(e) => updateField("container_number", e.target.value)} />
                </Field>
                <Field label="PIN / booking">
                  <input className={inputClass} value={form.pin_booking} onChange={(e) => updateField("pin_booking", e.target.value)} />
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

                <Field label="Data (domyślnie dzień roboczy przed rozładunkiem)">
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

                <Field label="Nazwa towaru">
                  <input className={inputClass} value={form.goods_name} onChange={(e) => updateField("goods_name", e.target.value)} />
                </Field>
                <Field label="Waga brutto">
                  <input className={inputClass} value={form.gross_weight} onChange={(e) => updateField("gross_weight", e.target.value)} placeholder="np. 18450 kg / według armatora" />
                </Field>

                <Field label="Miejsce złożenia pustego" full>
                  <input className={inputClass} value={form.submitted_where} onChange={(e) => updateField("submitted_where", e.target.value)} />
                </Field>

                <Field label="Kierowca (z Panelu floty)">
                  <select className={inputClass} value={form.driver_name} onChange={(e) => selectDriver(e.target.value)}>
                    <option value="">—</option>
                    {driverOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Nr dowodu kierowcy">
                  <input className={inputClass} value={form.driver_id_number} onChange={(e) => updateField("driver_id_number", e.target.value)} />
                </Field>

                <Field label="Pojazd (ciągnik, z Panelu floty)">
                  <select className={inputClass} value={form.vehicle_plate} onChange={(e) => selectTractor(e.target.value)}>
                    <option value="">—</option>
                    {tractorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Naczepa (z Panelu floty)">
                  <select className={inputClass} value={form.trailer_plate} onChange={(e) => updateField("trailer_plate", e.target.value)}>
                    <option value="">—</option>
                    {trailerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>

                <Field label="Telefon kierowcy">
                  <input className={inputClass} value={form.driver_phone} onChange={(e) => updateField("driver_phone", e.target.value)} />
                </Field>
                <Field label="Przewoźnik">
                  <input className={inputClass} value={carrierName} onChange={(e) => setCarrierName(e.target.value)} />
                </Field>

                <Field label="Stawka (PLN)">
                  <input type="number" step="0.01" className={inputClass} value={form.rate_amount ?? ""} onChange={(e) => updateField("rate_amount", e.target.value === "" ? null : Number(e.target.value))} />
                </Field>
                <Field label="Termin płatności (dni)">
                  <input type="number" className={inputClass} value={form.payment_terms_days ?? ""} onChange={(e) => updateField("payment_terms_days", e.target.value === "" ? null : Number(e.target.value))} />
                </Field>

                <Field label="Warunek płatności" full>
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
            <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
              Anuluj
            </button>
            <button
              type="button"
              disabled={stage === "saving" || (form.direction !== "I" && form.direction !== "E")}
              onClick={handleSave}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {stage === "saving" ? "Zapisywanie…" : existingLoad ? "Zapisz zmiany" : "Zapisz zlecenie"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Domyślny termin płatności kontrahenta wchodzi tylko w PUSTE pola — jeśli dokument (albo
// dyspozytor) podał własny termin, ten z dokumentu wygrywa; rozbieżność tylko sygnalizujemy.
function applyContractorDefaults(order: ParsedOrder, contractor: Contractor, warnings?: string[]): ParsedOrder {
  const next = { ...order };
  if (next.payment_terms_days === null && contractor.payment_terms_days !== null) {
    next.payment_terms_days = contractor.payment_terms_days;
    if (!next.payment_terms_note && contractor.payment_terms_note) next.payment_terms_note = contractor.payment_terms_note;
  } else if (
    warnings &&
    next.payment_terms_days !== null &&
    contractor.payment_terms_days !== null &&
    next.payment_terms_days !== contractor.payment_terms_days
  ) {
    warnings.push(`Termin płatności z dokumentu (${next.payment_terms_days} dni) różni się od ustawionego dla kontrahenta ${contractor.name} (${contractor.payment_terms_days} dni) — zostawiono wartość z dokumentu.`);
  }
  return next;
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
