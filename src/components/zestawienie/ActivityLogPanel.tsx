"use client";

import { useActivityLog } from "@/hooks/useActivityLog";
import type { ActivityLogEntry } from "@/types/activityLog";
import { COLUMNS } from "./columns";

const LABELS: Record<string, string> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
const TIME_FORMATTER = new Intl.DateTimeFormat("pl-PL", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("pl-PL");
  return String(value);
}

function describe(entry: ActivityLogEntry): { title: string; changes: string[] } {
  const order = entry.order_number ? `zlecenie ${entry.order_number}` : "zlecenie";
  if (entry.action === "insert") {
    const after = entry.after ?? {};
    const summary = ["container_number", "forwarder", "city"]
      .map((k) => after[k])
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map(String);
    return { title: `Dodano ${order}`, changes: summary.length ? [summary.join(" · ")] : [] };
  }
  if (entry.action === "delete") {
    return { title: `Usunięto ${order}`, changes: [] };
  }
  const after = entry.after ?? {};
  const before = entry.before ?? {};
  const changes = Object.keys(after).map(
    (key) => `${LABELS[key] ?? key}: ${formatValue(before[key])} → ${formatValue(after[key])}`
  );
  return { title: `Zmieniono ${order}`, changes };
}

/**
 * Panel "Historia" — kto, kiedy, co zmienił (wartość przed → po). Czyta `activity_log` dopisywany
 * triggerem w bazie, więc pokazuje też zmiany innych dyspozytorów i (w przyszłości) botów.
 */
export function ActivityLogPanel({ onClose }: { onClose: () => void }) {
  const { data, isLoading, isError, error } = useActivityLog(true);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Historia zmian</span>
        <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <p className="p-3 text-xs text-zinc-500">Wczytywanie…</p>}
        {isError && (
          <p className="p-3 text-xs text-red-600">
            Nie udało się wczytać historii: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {data && data.length === 0 && <p className="p-3 text-xs text-zinc-500">Brak wpisów.</p>}
        {data?.map((entry) => {
          const { title, changes } = describe(entry);
          return (
            <div key={entry.id} className="border-b border-zinc-100 px-3 py-2 text-xs dark:border-zinc-900">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
                <span className="shrink-0 text-zinc-400">{TIME_FORMATTER.format(new Date(entry.created_at))}</span>
              </div>
              <div className="text-zinc-500">{entry.actor}</div>
              {changes.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-zinc-700 dark:text-zinc-300">
                  {changes.map((change) => (
                    <li key={change} className="break-words">{change}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
