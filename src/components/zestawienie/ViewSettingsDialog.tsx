"use client";

import { useState } from "react";
import { useSaveViewSettings, useViewSettings } from "@/hooks/useViewSettings";
import {
  COMPACT_COLUMN_WIDTH,
  DEFAULT_VIEW_SETTINGS,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  moveColumn,
  resolveColumns,
  toStoredSettings,
  withAutoWidths,
  withColumnWidth,
  withCompactWidths,
  type ViewSettings,
} from "@/lib/view/viewSettings";
import { BLOCK_LABELS } from "./columns";

/**
 * "Widok" — każdy użytkownik sam wybiera kolumny, ich kolejność i ile pierwszych z nich zostaje
 * przyklejonych do lewej przy przewijaniu w bok (jak zamrożone kolumny w Excelu). Konfiguracja
 * leci do Supabase (public.user_view_settings), więc jedzie za człowiekiem na inne stanowisko.
 *
 * Każda zmiana zapisuje się od razu — okno nie ma przycisku "Zapisz", bo efekt widać w tabeli
 * pod spodem natychmiast (zapis optymistyczny w useSaveViewSettings).
 */
export function ViewSettingsDialog({
  measureColumnWidths,
  onClose,
}: {
  /** Aktualne szerokości widocznych kolumn (px) prosto z wyrenderowanej tabeli — patrz compactAll. */
  measureColumnWidths: () => Record<string, number>;
  onClose: () => void;
}) {
  const { data: settings = null, isLoading } = useViewSettings();
  const saveViewSettings = useSaveViewSettings();
  const [error, setError] = useState<string | null>(null);

  const view = resolveColumns(settings);
  const hiddenKeys = new Set(view.ordered.filter((column) => view.isHidden(column.key)).map((column) => String(column.key)));

  async function apply(next: ViewSettings) {
    setError(await saveViewSettings(next));
  }

  // Bieżąca konfiguracja w kształcie do zapisu — punkt wyjścia dla zmian szerokości.
  const current = toStoredSettings(view.ordered, hiddenKeys, view.frozen, view.widths);

  function toggleColumn(key: string) {
    const nextHidden = new Set(hiddenKeys);
    if (nextHidden.has(key)) nextHidden.delete(key);
    else nextHidden.add(key);
    void apply(toStoredSettings(view.ordered, nextHidden, view.frozen, view.widths));
  }

  function move(index: number, delta: number) {
    void apply(toStoredSettings(moveColumn(view.ordered, index, delta), hiddenKeys, view.frozen, view.widths));
  }

  // Bez sztywnego limitu — jedyna granica to liczba widocznych kolumn (zamrożenie wszystkiego
  // znaczy tyle, że nie ma już czego przewijać, ale nic się nie psuje).
  function setFrozen(value: number) {
    void apply(
      toStoredSettings(view.ordered, hiddenKeys, Math.max(0, Math.min(view.visible.length, value)), view.widths)
    );
  }

  function showAll() {
    void apply(toStoredSettings(view.ordered, new Set(), view.frozen, view.widths));
  }

  function resetToDefault() {
    // Szerokości zostają — "przywróć domyślne" dotyczy zestawu i kolejności kolumn; od szerokości
    // jest osobny guzik obok, żeby jedno kliknięcie nie kasowało dwóch różnych rzeczy naraz.
    void apply({ ...DEFAULT_VIEW_SETTINGS, frozen: view.frozen, widths: view.widths });
  }

  /**
   * Zwęża tylko WIDOCZNE kolumny (ukryta i tak nie zajmuje miejsca, a włączona później ma się
   * pokazać w naturalnej szerokości, nie przycięta bez uprzedzenia) i tylko te, które FAKTYCZNIE
   * są szersze niż docelowe. Bez tego drugiego warunku kolumny w rodzaju "Godz." czy "ADR",
   * naturalnie węższe od 110 px, dostałyby 110 px i tabela zrobiłaby się SZERSZA — dokładnie
   * odwrotnie niż mówi guzik (złapane testem w przeglądarce).
   */
  function compactAll() {
    const measured = measureColumnWidths();
    const keys = view.visible
      .map((column) => String(column.key))
      .filter((key) => (measured[key] ?? 0) > COMPACT_COLUMN_WIDTH);
    void apply(withCompactWidths(current, keys, COMPACT_COLUMN_WIDTH));
  }

  function autoWidths() {
    void apply(withAutoWidths(current));
  }

  function setWidth(key: string, width: number | null) {
    void apply(withColumnWidth(current, key, width));
  }

  /** Puste pole = "auto"; śmieci = zostaw jak było. Bez zmiany wartości nie ruszamy bazy. */
  function commitWidth(key: string, raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      if (view.widths[key] !== undefined) setWidth(key, null);
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return;
    if (view.widths[key] !== value) setWidth(key, value);
  }

  // Które kolumny faktycznie zostaną przyklejone — liczone po WIDOCZNYCH, żeby lista w oknie
  // mówiła to samo co tabela.
  const frozenKeys = new Set(view.visible.slice(0, view.frozen).map((column) => String(column.key)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Widok — kolumny, kolejność, szerokość, zamrażanie</h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
          <label className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
            Zamroź pierwsze
            <input
              type="number"
              min={0}
              max={view.visible.length}
              value={view.frozen}
              onChange={(e) => setFrozen(Number(e.target.value))}
              className="w-16 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
            kolumn (zostają przy lewej krawędzi przy przewijaniu w bok)
          </label>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={showAll} className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400">
              Pokaż wszystkie
            </button>
            <button type="button" onClick={resetToDefault} className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400">
              Przywróć domyślne
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
          <span className="text-zinc-700 dark:text-zinc-300">Szerokość kolumn</span>
          <button
            type="button"
            onClick={compactAll}
            title={`Ustawia każdą widoczną kolumnę na ${COMPACT_COLUMN_WIDTH} px; węższych nie rusza`}
            className="rounded-full border border-zinc-900 bg-zinc-900 px-3 py-1 font-medium text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Zwęź wszystkie
          </button>
          <button type="button" onClick={autoWidths} className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400">
            Szerokości: auto
          </button>
          <span className="text-zinc-500">
            Szerokość ustawisz też wprost w tabeli — przeciągnij prawą krawędź nagłówka (dwuklik wraca do „auto”).
          </span>
        </div>

        {error && <p className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">Nie udało się zapisać widoku: {error}</p>}
        {isLoading && <p className="px-4 py-2 text-xs text-zinc-500">Wczytywanie ustawień…</p>}

        <div className="min-h-0 flex-1 overflow-auto p-2">
          <p className="px-2 pb-2 text-[11px] text-zinc-500">
            Odznacz, czego nie chcesz widzieć. Strzałkami ustaw kolejność — kolumny zamrożone to
            {" "}
            {view.frozen === 0 ? "(na razie żadne)" : `pierwsze ${view.frozen} widoczne`}. Ustawienia są Twoje własne, nikomu innemu nie zmieniają widoku.
          </p>
          <ul>
            {view.ordered.map((column, index) => {
              const key = String(column.key);
              const isVisible = !hiddenKeys.has(key);
              return (
                <li
                  key={key}
                  className={`flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                    isVisible ? "" : "opacity-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isVisible}
                    onChange={() => toggleColumn(key)}
                    aria-label={`Pokaż kolumnę ${column.label}`}
                  />
                  <span className="w-56 truncate text-zinc-900 dark:text-zinc-100">{column.label}</span>
                  <span className="w-40 truncate text-zinc-400">{BLOCK_LABELS[column.block]}</span>
                  {/* Pole niekontrolowane + `key` zależny od zapisanej wartości: przepisujemy je
                      dopiero, gdy szerokość zmieni się gdzie indziej (przeciągnięcie w tabeli,
                      "Zwęź wszystkie"), a nie przy każdym wciśniętym klawiszu. */}
                  <input
                    key={`${key}-${view.widths[key] ?? "auto"}`}
                    type="number"
                    min={MIN_COLUMN_WIDTH}
                    max={MAX_COLUMN_WIDTH}
                    step={10}
                    defaultValue={view.widths[key] ?? ""}
                    placeholder="auto"
                    title={`Szerokość w pikselach (puste = dopasuj do treści). Zakres ${MIN_COLUMN_WIDTH}–${MAX_COLUMN_WIDTH}.`}
                    aria-label={`Szerokość kolumny ${column.label} w pikselach`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    onBlur={(e) => commitWidth(key, e.target.value)}
                    className="w-16 rounded border border-zinc-300 px-1 py-0.5 text-right text-[11px] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                  />
                  <span className="text-[11px] text-zinc-400">px</span>
                  {frozenKeys.has(key) && (
                    <span className="rounded-full border border-blue-300 px-2 py-0.5 text-[10px] text-blue-700 dark:border-blue-800 dark:text-blue-400">
                      zamrożona
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Przesuń ${column.label} w górę`}
                      className="rounded border border-zinc-300 px-2 leading-5 text-zinc-600 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-400"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === view.ordered.length - 1}
                      aria-label={`Przesuń ${column.label} w dół`}
                      className="rounded border border-zinc-300 px-2 leading-5 text-zinc-600 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-400"
                    >
                      ↓
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
