"use client";

import { EMPTY_STOP, STOP_KINDS, STOP_KIND_LABELS, type LoadStop } from "@/types/loadStop";

/**
 * Lista KOLEJNYCH (2., 3., …) miejsc załadunku/rozładunku jednego zlecenia.
 *
 * Właściciel: "zlecenia krajowe, bądź w sumie jakiekolwiek, mogą mieć więcej niż jeden
 * rozładunek/załadunek". Pierwsze miejsce zostaje w zwykłych polach zlecenia (miejscowość, firma,
 * adres, data, godzina) — tutaj dokładamy pozostałe. Ten sam komponent służy w oknie importu
 * (przed zapisem) i przy wierszu Zestawienia (poprawka po fakcie), żeby jedno i drugie miejsce
 * edycji miało dokładnie te same pola i tę samą kolejność.
 */
export function StopsEditor({
  stops,
  onChange,
  heading,
  emptyHint,
}: {
  stops: LoadStop[];
  onChange: (next: LoadStop[]) => void;
  heading: string;
  emptyHint: string;
}) {
  const update = (index: number, patch: Partial<LoadStop>) =>
    onChange(stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop)));

  return (
    <div className="rounded border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {heading}
          {stops.length > 0 ? ` (${stops.length})` : ""}
        </span>
        <button
          type="button"
          data-testid="dodaj-miejsce"
          onClick={() => onChange([...stops, { ...EMPTY_STOP }])}
          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          + Dodaj miejsce
        </button>
      </div>

      {stops.length === 0 ? (
        <p className="mt-1 text-[11px] text-zinc-500">{emptyHint}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {stops.map((stop, index) => (
            <li key={index} data-testid="kolejne-miejsce" className="grid grid-cols-6 gap-2 rounded bg-zinc-50 p-2 dark:bg-zinc-900">
              <label className="col-span-2 flex flex-col gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                Rodzaj
                <select
                  className={stopInputClass}
                  value={stop.kind}
                  onChange={(e) => update(index, { kind: e.target.value as LoadStop["kind"] })}
                >
                  {STOP_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {STOP_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 flex flex-col gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                Miejscowość
                <input
                  data-testid="miejsce-miejscowosc"
                  className={stopInputClass}
                  value={stop.city}
                  onChange={(e) => update(index, { city: e.target.value })}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                Firma
                <input className={stopInputClass} value={stop.company_name} onChange={(e) => update(index, { company_name: e.target.value })} />
              </label>
              <label className="col-span-3 flex flex-col gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                Adres
                <input className={stopInputClass} value={stop.address} onChange={(e) => update(index, { address: e.target.value })} />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                Data
                <input type="date" className={stopInputClass} value={stop.date} onChange={(e) => update(index, { date: e.target.value })} />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                Godzina
                <input className={stopInputClass} value={stop.time} onChange={(e) => update(index, { time: e.target.value })} placeholder="np. 08:30" />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                Uwagi
                <input className={stopInputClass} value={stop.notes} onChange={(e) => update(index, { notes: e.target.value })} />
              </label>
              <button
                type="button"
                data-testid="usun-miejsce"
                onClick={() => onChange(stops.filter((_, i) => i !== index))}
                aria-label={`Usuń miejsce ${index + 2}`}
                className="self-end justify-self-end rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:border-zinc-700"
              >
                Usuń
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const stopInputClass =
  "w-full rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";
