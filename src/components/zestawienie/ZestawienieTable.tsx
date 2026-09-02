"use client";

import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Load, Direction } from "@/types/load";
import { useDeleteLoad, useUpdateLoad } from "@/hooks/useLoads";
import { PICKUP_LOCATIONS } from "@/lib/orderTemplates/pickupLocations";
import { EMPTY_FLEET, useFleet, withCurrentOption, type Fleet } from "@/lib/fleet/fleetStore";
import { COLUMNS, BLOCK_LABELS, type ColumnBlock, type ColumnDef } from "./columns";
import { ImportOrderDialog } from "./ImportOrderDialog";
import { ActivityLogPanel } from "./ActivityLogPanel";
import { ContractorsDialog } from "./ContractorsDialog";
import { useContractors } from "@/hooks/useContractors";
import type { Contractor } from "@/types/contractor";

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

function formatCell(value: unknown, kind: ColumnDef["kind"], contractorNames: Map<string, string>): string {
  if (value === null || value === undefined || value === "") return "";
  if (kind === "number" && typeof value === "number") {
    return value.toLocaleString("pl-PL");
  }
  if (kind === "contractor") return contractorNames.get(String(value)) ?? "(nieznany kontrahent)";
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

type Dialog = { kind: "import" } | { kind: "attach"; load: Load } | { kind: "contractors" };

export function ZestawienieTable({ loads }: { loads: Load[] }) {
  const [visibleBlocks, setVisibleBlocks] = useState<Record<ColumnBlock, boolean>>({
    ladunek: true,
    rozliczenie: false,
    fakturowanie: false,
    inne: false,
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const updateLoad = useUpdateLoad();
  const deleteLoad = useDeleteLoad();
  const { data: fleetData } = useFleet();
  const fleet = fleetData ?? EMPTY_FLEET;
  const { data: contractors = [] } = useContractors();
  const contractorNames = useMemo(() => new Map(contractors.map((c) => [c.id, c.name])), [contractors]);

  const columns = useMemo(
    () => COLUMNS.filter((column) => visibleBlocks[column.block]),
    [visibleBlocks]
  );

  const dayGroups = useMemo(() => groupByDay(loads), [loads]);
  // Od najnowszego — fallback "z poprzedniego zlecenia" przy dopasowaniu do floty.
  const recentLoads = useMemo(
    () => [...loads].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
    [loads]
  );

  function toggleBlock(block: ColumnBlock) {
    if (block === "ladunek") return;
    setVisibleBlocks((prev) => ({ ...prev, [block]: !prev[block] }));
  }

  async function commitCell(load: Load, column: ColumnDef, raw: string) {
    setEditingCell(null);
    setSaveError(null);
    const patch = buildPatch(column, raw, fleet, contractors, load);
    if (patch[column.key] === load[column.key]) return;
    const error = await updateLoad(load.id, patch);
    if (error) setSaveError(`Nie udało się zapisać pola "${column.label}": ${error}`);
  }

  async function handleDelete(load: Load) {
    const label = load.order_number ? `zlecenie ${load.order_number}` : "to zlecenie";
    if (!window.confirm(`Usunąć ${label}? Tej operacji nie da się cofnąć.`)) return;
    setSaveError(null);
    const error = await deleteLoad(load.id);
    if (error) setSaveError(`Nie udało się usunąć: ${error}`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Zestawienie
        </span>
        <button
          type="button"
          onClick={() => setDialog({ kind: "import" })}
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
          <button
            type="button"
            onClick={() => setDialog({ kind: "contractors" })}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
          >
            Kontrahenci
          </button>
          <button
            type="button"
            onClick={() => setIsHistoryOpen((open) => !open)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              isHistoryOpen
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
            }`}
          >
            Historia
          </button>
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

      {dialog?.kind === "import" && (
        <ImportOrderDialog recentLoads={recentLoads} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "contractors" && <ContractorsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "attach" && (
        <ImportOrderDialog
          mode="attach"
          existingLoad={dialog.load}
          recentLoads={recentLoads.filter((l) => l.id !== dialog.load.id)}
          onClose={() => setDialog(null)}
        />
      )}

      {/* min-h-0: bez tego element flex nie może być niższy niż jego zawartość, więc
          overflow-auto nigdy nie zadziała, a poziomy pasek przewijania ląduje TUŻ pod
          ostatnim wierszem (zasłaniając go) zamiast na dole okna. */}
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
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
              <th className="border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800" />
            </tr>
          </thead>
          <tbody>
            {dayGroups.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-2 py-6 text-center text-zinc-500">
                  Brak ładunków.
                </td>
              </tr>
            )}
            {dayGroups.map((group) => (
              <DayGroupRows
                key={group.dateKey}
                group={group}
                columns={columns}
                fleet={fleet}
                contractors={contractors}
                contractorNames={contractorNames}
                editingCell={editingCell}
                onStartEdit={setEditingCell}
                onCancelEdit={() => setEditingCell(null)}
                onCommit={commitCell}
                onAttach={(load) => setDialog({ kind: "attach", load })}
                onDelete={handleDelete}
              />
            ))}
          </tbody>
        </table>
      </div>
      {isHistoryOpen && <ActivityLogPanel onClose={() => setIsHistoryOpen(false)} />}
      </div>
    </div>
  );
}

interface RowHandlers {
  fleet: Fleet;
  contractors: Contractor[];
  contractorNames: Map<string, string>;
  editingCell: EditingCell | null;
  onStartEdit: (cell: EditingCell) => void;
  onCancelEdit: () => void;
  onCommit: (load: Load, column: ColumnDef, raw: string) => void;
  onAttach: (load: Load) => void;
  onDelete: (load: Load) => void;
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
          colSpan={columns.length + 1}
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
  fleet,
  contractors,
  contractorNames,
  editingCell,
  onStartEdit,
  onCancelEdit,
  onCommit,
  onAttach,
  onDelete,
}: { direction: Direction; loads: Load[]; columns: ColumnDef[]; isFirst: boolean } & RowHandlers) {
  return (
    <>
      <tr>
        {/* Gruba kreska oddziela eksporty od importów w obrębie dnia — nie
            tylko kolor tła, ale wyraźna, pogrubiona krawędź. */}
        <td
          colSpan={columns.length + 1}
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
                    fleet={fleet}
                    contractors={contractors}
                    onCancel={onCancelEdit}
                    onCommit={(raw) => onCommit(load, column, raw)}
                  />
                ) : (
                  formatCell(load[column.key], column.kind, contractorNames)
                )}
              </td>
            );
          })}
          <td className="whitespace-nowrap px-2 py-1">
            <button
              type="button"
              onClick={() => onAttach(load)}
              title="Dopnij brakujący dokument (np. list przewozowy) do tego zlecenia"
              className="mr-1 rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-zinc-500 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Dopnij PDF
            </button>
            <button
              type="button"
              onClick={() => onDelete(load)}
              title="Usuń zlecenie"
              className="rounded border border-red-200 px-2 py-0.5 text-[11px] text-red-600 hover:border-red-400 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
            >
              Usuń
            </button>
          </td>
        </tr>
      ))}
    </>
  );
}

// Edycja inline: Enter zapisuje, Esc anuluje, kliknięcie poza komórką anuluje (zapis TYLKO
// świadomym Enterem — przypadkowy zapis jest gorszy niż utrata jednej poprawki). Listy rozwijane
// (kierunek, podjęcie, kierowca/pojazd/naczepa z Panelu floty) zapisują od razu po wyborze — wybór
// z listy jest już świadomą decyzją.
function CellEditor({
  load,
  column,
  fleet,
  contractors,
  onCancel,
  onCommit,
}: {
  load: Load;
  column: ColumnDef;
  fleet: Fleet;
  contractors: Contractor[];
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

  const selectOptions = selectOptionsFor(column, draft, fleet, contractors);
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

function selectOptionsFor(
  column: ColumnDef,
  current: string,
  fleet: Fleet,
  contractors: Contractor[]
): { value: string; label: string }[] | null {
  switch (column.key) {
    case "contractor_id":
      return contractors.map((c) => ({ value: c.id, label: c.name }));
    case "direction":
      return [
        { value: "I", label: "Import" },
        { value: "E", label: "Eksport" },
      ];
    case "pickup_type":
      return withCurrentOption([...PICKUP_LOCATIONS], current);
    case "driver_name":
      return withCurrentOption(fleet.drivers.map((d) => d.name), current);
    case "vehicle_plate":
      return withCurrentOption(fleet.tractors.map((v) => v.plate), current);
    case "trailer_plate":
      return withCurrentOption(fleet.trailers.map((v) => v.plate), current);
    default:
      return null;
  }
}

// Wybór kierowcy z Panelu floty ustawia też nr dowodu (z `driver_documents`), jeśli Panel go zna.
// Wybór kontrahenta podstawia jego domyślny termin płatności TYLKO gdy zlecenie jeszcze go nie ma.
function buildPatch(column: ColumnDef, raw: string, fleet: Fleet, contractors: Contractor[], load?: Load): Partial<Load> {
  const value = coerceCellValue(column, raw);
  const patch: Partial<Load> = { [column.key]: value } as Partial<Load>;
  if (column.key === "driver_name" && typeof value === "string") {
    const driver = fleet.drivers.find((d) => d.name === value);
    if (driver?.docNumber) patch.driver_id_number = driver.docNumber;
  }
  if (column.key === "contractor_id" && typeof value === "string") {
    const contractor = contractors.find((c) => c.id === value);
    if (contractor && load && load.payment_terms_days === null && contractor.payment_terms_days !== null) {
      patch.payment_terms_days = contractor.payment_terms_days;
      patch.payment_terms_note = load.payment_terms_note ?? contractor.payment_terms_note;
    }
  }
  return patch;
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
