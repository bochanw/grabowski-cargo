"use client";

import { useState } from "react";
import { useUpdateLoad } from "@/hooks/useLoads";
import { StopsEditor } from "./StopsEditor";
import { isStopEmpty, normalizeStops, type LoadStop } from "@/types/loadStop";
import { isExportSide } from "@/lib/loads/direction";
import type { Load } from "@/types/load";

/**
 * Kolejne miejsca załadunku/rozładunku przy JUŻ ZAPISANYM zleceniu.
 *
 * Osobne okno, a nie edycja inline w komórce: w bazie stoi tam lista (jsonb), a edytor komórki
 * zapisuje tekst — jedno wciśnięcie Entera skasowałoby wszystkie miejsca. Stąd komórka „Kolejne
 * miejsca" otwiera to okno zamiast edytora.
 */
export function LoadStopsDialog({ load, onClose }: { load: Load; onClose: () => void }) {
  const updateLoad = useUpdateLoad();
  const [stops, setStops] = useState<LoadStop[]>(() => normalizeStops(load.stops));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    // Puste wiersze (dodane i nieuzupełnione) nie mają po co iść do bazy — "2 miejsca" w tabeli ma
    // znaczyć dwa prawdziwe adresy.
    const problem = await updateLoad(load.id, { stops: stops.filter((stop) => !isStopEmpty(stop)) });
    setSaving(false);
    if (problem) {
      setError(problem);
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Kolejne miejsca — zlecenie {load.order_number ?? "(bez numeru)"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <p className="mb-2 text-xs text-zinc-500">
            Pierwsze miejsce zlecenia to kolumny „Miejscowość", „Dane firmy", „Adres", „Data (2)"
            i „Godz." w tabeli — poprawia się je tam. Tutaj stoją miejsca drugie i dalsze.
          </p>
          <StopsEditor
            stops={stops}
            onChange={setStops}
            heading={`Kolejne miejsca ${isExportSide(load.direction) ? "załadunku" : "rozładunku"}`}
            emptyHint="To zlecenie ma jedno miejsce. Dodaj kolejne, jeśli samochód jedzie pod więcej niż jeden adres."
          />
          {error && (
            <p className="mt-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              Nie udało się zapisać: {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
            Anuluj
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            data-testid="zapisz-miejsca"
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {saving ? "Zapisywanie…" : "Zapisz miejsca"}
          </button>
        </div>
      </div>
    </div>
  );
}
