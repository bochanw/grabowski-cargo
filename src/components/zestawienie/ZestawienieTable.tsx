"use client";

import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Load, Direction } from "@/types/load";
import { useUpdateLoadField } from "@/hooks/useLoads";
import { PICKUP_LOCATIONS } from "@/lib/orderTemplates/pickupLocations";
import { COLUMNS, BLOCK_LABELS, type ColumnBlock, type ColumnDef } from "./columns";
import { ImportOrderDialog } from "./ImportOrderDialog";

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("pl-PL", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function formatDayHeading(loadDate: string | null): string {
  if (!loadDate) return "Bez daty";
  const parsed = new Date(`${loadDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return loadDate;
  return WEEKDAY_FORMATTER.format(parsed);
}

function formatCell(value: unknown, kind: "number" | "date" | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (kind === "number" && typeof value === "number") {
    return value.toLocaleString("pl-PL");
  }
  return String(value);
}

interface DayGroup {
  dateKey: string;
  loads: Load[];
}

function groupByDay(loads: Load[]): DayGroup[] {
  const map = new Map<string, Load[]>();
  for (const load of loads) {
    const key = load.load_date ?? "";
    const bucket = map.get(key);
    if (bucket) bucket.push(load);
    else map.set(key, [load]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    })
    .map(([dateKey, dayLoads]) => ({ dateKey, loads: dayLoads }));
}

const DIRECTION_ORDER: Direction[] = ["E", "I"];
const DIRECTION_LABELS: Record<Direction, string> = {
  E: "Eksport",
  I: "Import",
};

interface EditingCell {
  id: string;
  key: keyof Load;
}

export function ZestawienieTable({ loads }: { loads: Load[] }) {
  const [visibleBlocks, setVisibleBlocks] = useState<Record<ColumnBlock, boolean>>({
    ladunek: true,
    rozliczenie: false,
    fakturowanie: false,
    inne: false,
  });
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const updateLoadField = useUpdateLoadField();

  const columns = useMemo(
    () => COLUMNS.filter((column) => visibleBlocks[column.block]),
    [visibleBlocks]
  );

  const dayGroups = useMemo(() => groupByDay(loads), [loads]);

  function toggleBlock(block: ColumnBlock) {
    if (block === "ladunek") return;
    setVisibleBlocks((prev) => ({ ...prev, [block]: !prev[block] }));
  }

  async function commitCell(load: Load, column: ColumnDef, raw: string) {
    setEditingCell(null);
    setSaveError(null);
    const value = coerceCellValue(column, raw);
    if (value === load[column.key]) return;
    const error = await updateLoadField(load.id, column.key, value as Load[typeof column.key]);
    if (error) setSaveError(`Nie udało się zapisać pola "${column.label}": ${error}`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Zestawienie
        </span>
        <button
          type="button"
          onClick={() => setIsImportOpen(true)}
          className="rounded-full border border-zinc-900 bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
        >
          + Importuj zlecenie (PDF)
        </button>
        {saveError ? (
          <span className="text-xs text-red-600">{saveError}</span>
        ) : (
          <span className="text-xs text-zinc-400">Kliknij komórkę, żeby edytować — Enter zapisuje, Esc anuluje.</span>
        )}
        <div className="ml-auto flex gap-2">
          {(Object.keys(BLOCK_LABELS) as ColumnBlock[])
            .filter((block) => block !== "ladunek")
            .map((block) => (
              <button
                key={block}
                type="button"
                onClick={() => toggleBlock(block)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  visibleBlocks[block]
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                {BLOCK_LABELS[block]}
              </button>
            ))}
        </div>
      </div>

      {isImportOpen && <ImportOrderDialog onClose={() => setIsImportOpen(false)} />}

      {/* min-h-0: bez tego element flex nie może być niższy niż jego zawartość, więc
          overflow-auto nigdy nie zadziała, a poziomy pasek przewijania ląduje TUŻ pod
          ostatnim wierszem (zasłaniając go) zamiast na dole okna. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-max border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-100 dark:bg-zinc-900">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`whitespace-nowrap border-b border-zinc-200 px-2 py-1.5 text-left font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400 ${
                    column.align === "right" ? "text-right" : ""
                  }`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dayGroups.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-2 py-6 text-center text-zinc-500">
                  Brak ładunków.
                </td>
              </tr>
            )}
            {dayGroups.map((group) => (
              <DayGroupRows
                key={group.dateKey}
                group={group}
                columns={columns}
                editingCell={editingCell}
                onStartEdit={setEditingCell}
                onCancelEdit={() => setEditingCell(null)}
                onCommit={commitCell}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RowHandlers {
  editingCell: EditingCell | null;
  onStartEdit: (cell: EditingCell) => void;
  onCancelEdit: () => void;
  onCommit: (load: Load, column: ColumnDef, raw: string) => void;
}

function DayGroupRows({
  group,
  columns,
  ...handlers
}: { group: DayGroup; columns: ColumnDef[] } & RowHandlers) {
  const byDirection = new Map<Direction, Load[]>();
  for (const direction of DIRECTION_ORDER) byDirection.set(direction, []);
  for (const load of group.loads) {
    byDirection.get(load.direction)?.push(load);
  }

  const presentDirections = DIRECTION_ORDER.filter(
    (direction) => (byDirection.get(direction)?.length ?? 0) > 0
  );

  return (
    <>
      <tr>
        <td
          colSpan={columns.length}
          className="border-y border-zinc-300 bg-zinc-200 px-2 py-1 text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          {formatDayHeading(group.dateKey || null)}
        </td>
      </tr>
      {presentDirections.map((direction, index) => (
        <DirectionRows
          key={direction}
          direction={direction}
          loads={byDirection.get(direction) ?? []}
          columns={columns}
          isFirst={index === 0}
          {...handlers}
        />
      ))}
    </>
  );
}

function DirectionRows({
  direction,
  loads,
  columns,
  isFirst,
  editingCell,
  onStartEdit,
  onCancelEdit,
  onCommit,
}: { direction: Direction; loads: Load[]; columns: ColumnDef[]; isFirst: boolean } & RowHandlers) {
  return (
    <>
      <tr>
        {/* Gruba kreska oddziela eksporty od importów w obrębie dnia — nie
            tylko kolor tła, ale wyraźna, pogrubiona krawędź. */}
        <td
          colSpan={columns.length}
          className={`bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-950 dark:text-zinc-500 ${
            !isFirst ? "border-t-4 border-zinc-900 dark:border-zinc-100" : ""
          }`}
        >
          {DIRECTION_LABELS[direction]}
        </td>
      </tr>
      {loads.map((load) => (
        <tr
          key={load.id}
          className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900"
        >
          {columns.map((column) => {
            const isEditing = editingCell?.id === load.id && editingCell.key === column.key;
            return (
              <td
                key={column.key}
                onClick={() => {
                  if (!isEditing) onStartEdit({ id: load.id, key: column.key });
                }}
                className={`whitespace-nowrap px-2 py-1 text-zinc-800 dark:text-zinc-200 ${
                  column.align === "right" ? "text-right tabular-nums" : ""
                } ${isEditing ? "p-0" : "cursor-text"}`}
              >
                {isEditing ? (
                  <CellEditor
                    load={load}
                    column={column}
                    onCancel={onCancelEdit}
                    onCommit={(raw) => onCommit(load, column, raw)}
                  />
                ) : (
                  formatCell(load[column.key], column.kind)
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

// Edycja inline: Enter zapisuje, Esc anuluje, kliknięcie poza komórką anuluje (zapis TYLKO
// świadomym Enterem — przypadkowy zapis jest gorszy niż utrata jednej poprawki). Listy rozwijane
// (kierunek, podjęcie) zapisują od razu po wyborze — wybór z listy jest już świadomą decyzją.
function CellEditor({
  load,
  column,
  onCancel,
  onCommit,
}: {
  load: Load;
  column: ColumnDef;
  onCancel: () => void;
  onCommit: (raw: string) => void;
}) {
  const initial = load[column.key];
  const [draft, setDraft] = useState(initial === null || initial === undefined ? "" : String(initial));

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onCommit(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  const editorClass =
    "w-full min-w-24 border border-zinc-900 bg-white px-2 py-1 text-xs text-zinc-900 outline-none dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-50";

  const selectOptions = selectOptionsFor(column, draft);
  if (selectOptions) {
    return (
      <select
        autoFocus
        value={draft}
        onChange={(e) => onCommit(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        className={editorClass}
      >
        {column.key !== "direction" && <option value="">—</option>}
        {selectOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      autoFocus
      type={column.kind === "date" ? "date" : column.kind === "number" ? "number" : "text"}
      step={column.kind === "number" ? "any" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={onCancel}
      className={editorClass}
    />
  );
}

function selectOptionsFor(column: ColumnDef, current: string): { value: string; label: string }[] | null {
  if (column.key === "direction") {
    return [
      { value: "I", label: "Import" },
      { value: "E", label: "Eksport" },
    ];
  }
  if (column.key === "pickup_type") {
    // Wartość spoza listy (np. "poimport" z arkusza) pokazujemy jako opcję zamiast ją gubić.
    const options = [...PICKUP_LOCATIONS] as string[];
    if (current && !options.includes(current)) options.push(current);
    return options.map((value) => ({ value, label: value }));
  }
  return null;
}

function coerceCellValue(column: ColumnDef, raw: string): string | number | null {
  const trimmed = raw.trim();
  if (column.kind === "number") {
    if (trimmed === "") return null;
    const value = Number(trimmed.replace(",", "."));
    return Number.isFinite(value) ? value : null;
  }
  return trimmed === "" ? null : trimmed;
}
