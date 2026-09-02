"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Load, Direction } from "@/types/load";
import { useDeleteLoad, useUpdateLoad } from "@/hooks/useLoads";
import { PICKUP_LOCATIONS } from "@/lib/orderTemplates/pickupLocations";
import { EMPTY_FLEET, useFleet, withCurrentOption, type Fleet } from "@/lib/fleet/fleetStore";
import { canOverwriteGrossWeight, computeGrossWeightKg } from "@/lib/containers/tare";
import { loadSearchText, matchesQuery } from "@/lib/search/loadSearch";
import { type ColumnDef } from "./columns";
import { ImportOrderDialog } from "./ImportOrderDialog";
import { ActivityLogPanel } from "./ActivityLogPanel";
import { ContractorsDialog } from "./ContractorsDialog";
import { InvoiceDialog } from "./InvoiceDialog";
import { ViewSettingsDialog } from "./ViewSettingsDialog";
import { useContractors } from "@/hooks/useContractors";
import { useViewSettings } from "@/hooks/useViewSettings";
import { resolveColumns } from "@/lib/view/viewSettings";
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

/**
 * Zamrożone kolumny (jak w Excelu): pierwsze N kolumn zostaje przy lewej krawędzi przy
 * przewijaniu w bok. Indeks 0 to kolumna zaznaczenia, 1..N kolejne kolumny danych.
 *
 * `position: sticky` nie umie "przyklej za poprzednią" — `left` musi być konkretną wartością, a
 * szerokości kolumn wynikają z treści. Zamiast narzucać kolumnom stałe szerokości, mierzymy
 * nagłówek i wpisujemy odsunięcia w zmienne CSS na elemencie <table> (patrz applyFrozenOffsets);
 * komórki czytają je przez var(). Zmienne, nie stan Reacta, świadomie: pomiar po każdym renderze
 * przez setState kaskadowałby kolejne rendery całej tabeli.
 */
function stickyCellStyle(index: number, frozenCount: number, zIndex: number): CSSProperties | undefined {
  if (frozenCount === 0 || index > frozenCount) return undefined;
  return { position: "sticky", left: `var(--frozen-left-${index}, 0px)`, zIndex };
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

type Dialog =
  | { kind: "import" }
  | { kind: "attach"; load: Load }
  | { kind: "contractors" }
  | { kind: "view" }
  | { kind: "invoice"; loadIds: string[] };

export function ZestawienieTable({ loads }: { loads: Load[] }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const updateLoad = useUpdateLoad();
  const deleteLoad = useDeleteLoad();
  const { data: fleetData } = useFleet();
  const fleet = fleetData ?? EMPTY_FLEET;
  const { data: contractors = [] } = useContractors();
  const contractorNames = useMemo(() => new Map(contractors.map((c) => [c.id, c.name])), [contractors]);

  // Widok jest PER UŻYTKOWNIK (Supabase, migracja 0007): które kolumny, w jakiej kolejności i ile
  // pierwszych zamrożonych. Dopóki ustawienia się wczytują, `resolveColumns(null)` daje widok
  // domyślny — tabela nie miga pustymi kolumnami.
  const { data: viewSettings = null } = useViewSettings();
  const view = useMemo(() => resolveColumns(viewSettings), [viewSettings]);
  const columns = view.visible;
  const frozenCount = view.frozen;

  // Wyszukiwarka: filtr w pamięci po WSZYSTKICH polach rekordu + nazwie kontrahenta. Tekst do
  // przeszukania liczony raz na rekord (nie przy każdym wciśnięciu klawisza).
  const searchIndex = useMemo(
    () => new Map(loads.map((load) => [load.id, loadSearchText(load, load.contractor_id ? contractorNames.get(load.contractor_id) : undefined)])),
    [loads, contractorNames]
  );
  const visibleLoads = useMemo(
    () => (query.trim() === "" ? loads : loads.filter((load) => matchesQuery(searchIndex.get(load.id) ?? "", query))),
    [loads, query, searchIndex]
  );

  const dayGroups = useMemo(() => groupByDay(visibleLoads), [visibleLoads]);
  // Od najnowszego — fallback "z poprzedniego zlecenia" przy dopasowaniu do floty.
  const recentLoads = useMemo(
    () => [...loads].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
    [loads]
  );

  // Pomiar zamrożonych kolumn: `left` dla `position: sticky` musi być liczbą, a szerokości
  // kolumn wynikają z treści, więc bierzemy je z wyrenderowanego nagłówka. Indeks 0 = kolumna
  // zaznaczenia, 1..N = kolejne zamrożone kolumny danych. Pomiar nie zmienia szerokości (sticky
  // nie wyjmuje komórki z układu), więc nie ma pętli pomiar → layout → pomiar.
  const headerRefs = useRef<(HTMLTableCellElement | null)[]>([]);
  const tableRef = useRef<HTMLTableElement>(null);

  const applyFrozenOffsets = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    let offset = 0;
    for (let index = 0; index <= frozenCount; index += 1) {
      table.style.setProperty(`--frozen-left-${index}`, `${offset}px`);
      // getBoundingClientRect, nie offsetWidth: offsetWidth zaokrągla do pełnych pikseli, a przy
      // kilkunastu zamrożonych kolumnach te ułamki sumują się w widoczne przesunięcie.
      offset += headerRefs.current[index]?.getBoundingClientRect().width ?? 0;
    }
  }, [frozenCount]);

  // Przed malowaniem (useLayoutEffect), żeby przyklejone kolumny nie mrugnęły w złym miejscu po
  // zmianie zestawu kolumn albo liczby wierszy.
  useLayoutEffect(() => {
    applyFrozenOffsets();
  }, [applyFrozenOffsets, columns, visibleLoads.length]);

  useEffect(() => {
    const table = tableRef.current;
    if (!table || typeof ResizeObserver === "undefined") return;
    // Tabela ma `w-full min-w-max`, więc przy wąskiej zawartości szerokości kolumn zależą od
    // szerokości okna — po zmianie rozmiaru trzeba przeliczyć odsunięcia.
    const observer = new ResizeObserver(() => applyFrozenOffsets());
    observer.observe(table);
    return () => observer.disconnect();
  }, [applyFrozenOffsets]);

  // Ctrl+K / Cmd+K — kursor w wyszukiwarce (UX dyspozytorski: bez myszki).
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedLoads = useMemo(() => loads.filter((load) => selectedIds.has(load.id)), [loads, selectedIds]);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          + Nowe zlecenie (PDF / ręcznie)
        </button>
        <div className="relative">
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Szukaj: kontener, kierowca, terminal, klient… (Ctrl+K)"
            className="w-80 rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </div>
        {query.trim() !== "" && (
          <span className="text-xs text-zinc-500">
            {visibleLoads.length} z {loads.length}
          </span>
        )}
        {selectedLoads.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setDialog({ kind: "invoice", loadIds: selectedLoads.map((l) => l.id) })}
              className="rounded-full border border-zinc-900 bg-zinc-900 px-3 py-1 text-xs font-medium text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Wystaw fakturę ({selectedLoads.length})
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-zinc-500 underline hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              odznacz
            </button>
          </>
        )}
        {saveError ? (
          <span className="text-xs text-red-600">{saveError}</span>
        ) : (
          selectedLoads.length === 0 && (
            <span className="hidden text-xs text-zinc-400 xl:inline">Kliknij komórkę, żeby edytować — Enter zapisuje, Esc anuluje.</span>
          )
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
          {/* Przełączniki bloków (Ładunek/Rozliczenie/Fakturowanie/Inne) świadomie USUNIĘTE —
              właściciel: "daj każdemu wszystko i najwyżej będziemy sobie ręcznie wyłączać".
              Wszystko, czym da się sterować widokiem, siedzi w jednym oknie. */}
          <button
            type="button"
            onClick={() => setDialog({ kind: "view" })}
            title="Wybierz kolumny, ich kolejność i ile pierwszych zamrozić"
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
          >
            Widok ({columns.length}/{view.ordered.length} kolumn)
          </button>
        </div>
      </div>

      {dialog?.kind === "import" && (
        <ImportOrderDialog recentLoads={recentLoads} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "contractors" && <ContractorsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "view" && <ViewSettingsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "invoice" && (
        <InvoiceDialog
          // Świeże rekordy z listy (dialog mógł zostać otwarty przed aktualizacją Realtime).
          loads={dialog.loadIds.map((id) => loads.find((l) => l.id === id)).filter((l): l is Load => Boolean(l))}
          contractors={contractors}
          onClose={() => {
            setDialog(null);
            setSelectedIds(new Set());
          }}
        />
      )}
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
        {/* border-separate (zamiast collapse): przy zamrożonych kolumnach `border-collapse`
            gubi krawędzie przyklejonych komórek — obramowania siedzą wtedy na wspólnej siatce
            tabeli, nie na komórce, która się przesuwa. Stąd ramki wierszy są na <td>, nie na <tr>
            (w trybie separate przeglądarka ignoruje obramowanie wiersza). */}
        <table ref={tableRef} className="w-full min-w-max border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-100 dark:bg-zinc-900">
            <tr>
              <th
                ref={(element) => {
                  headerRefs.current[0] = element;
                }}
                style={stickyCellStyle(0, frozenCount, 20)}
                className="w-8 border-b border-zinc-200 bg-zinc-100 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900"
              />
              {columns.map((column, index) => (
                <th
                  key={column.key}
                  ref={(element) => {
                    headerRefs.current[index + 1] = element;
                  }}
                  style={stickyCellStyle(index + 1, frozenCount, 20)}
                  className={`whitespace-nowrap border-b border-zinc-200 bg-zinc-100 px-2 py-1.5 text-left font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 ${
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
                <td colSpan={columns.length + 2} className="px-2 py-6 text-center text-zinc-500">
                  Brak ładunków.
                </td>
              </tr>
            )}
            {dayGroups.map((group) => (
              <DayGroupRows
                key={group.dateKey}
                group={group}
                columns={columns}
                frozenCount={frozenCount}
                fleet={fleet}
                contractors={contractors}
                contractorNames={contractorNames}
                editingCell={editingCell}
                onStartEdit={setEditingCell}
                onCancelEdit={() => setEditingCell(null)}
                onCommit={commitCell}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                onAttach={(load) => setDialog({ kind: "attach", load })}
                onInvoice={(load) => setDialog({ kind: "invoice", loadIds: [load.id] })}
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
  /** Ile pierwszych kolumn jest przyklejonych do lewej — patrz stickyCellStyle. 0 = żadna. */
  frozenCount: number;
  fleet: Fleet;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  contractors: Contractor[];
  contractorNames: Map<string, string>;
  editingCell: EditingCell | null;
  onStartEdit: (cell: EditingCell) => void;
  onCancelEdit: () => void;
  onCommit: (load: Load, column: ColumnDef, raw: string) => void;
  onAttach: (load: Load) => void;
  onInvoice: (load: Load) => void;
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
          colSpan={columns.length + 2}
          className="border-y border-zinc-300 bg-zinc-200 px-2 py-1 text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          {/* Nagłówek dnia rozciąga się na całą szerokość — przyklejamy sam napis, żeby nie
              uciekał z ekranu przy przewijaniu w bok. */}
          <div className="sticky left-2 w-fit">{formatDayHeading(group.dateKey || null)}</div>
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
  frozenCount,
  fleet,
  selectedIds,
  onToggleSelected,
  contractors,
  contractorNames,
  editingCell,
  onStartEdit,
  onCancelEdit,
  onCommit,
  onAttach,
  onInvoice,
  onDelete,
}: { direction: Direction; loads: Load[]; columns: ColumnDef[]; isFirst: boolean } & RowHandlers) {
  return (
    <>
      <tr>
        {/* Gruba kreska oddziela eksporty od importów w obrębie dnia — nie
            tylko kolor tła, ale wyraźna, pogrubiona krawędź. */}
        <td
          colSpan={columns.length + 2}
          className={`bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-950 dark:text-zinc-500 ${
            !isFirst ? "border-t-4 border-zinc-900 dark:border-zinc-100" : ""
          }`}
        >
          <div className="sticky left-2 w-fit">{DIRECTION_LABELS[direction]}</div>
        </td>
      </tr>
      {loads.map((load) => (
        // Tło wiersza jest jawne (nie przezroczyste), bo zamrożone komórki dziedziczą je przez
        // `bg-inherit` — inaczej treść przewijanych kolumn byłaby przez nie widoczna. Dzięki
        // dziedziczeniu podświetlenie (hover / zaznaczenie) działa też na przyklejonych komórkach.
        <tr
          key={load.id}
          className={`bg-white hover:bg-zinc-50 dark:bg-zinc-950 dark:hover:bg-zinc-900 ${
            selectedIds.has(load.id) ? "!bg-blue-50 dark:!bg-blue-950/40" : ""
          }`}
        >
          <td
            style={stickyCellStyle(0, frozenCount, 1)}
            className={`border-b border-zinc-100 px-2 py-1 dark:border-zinc-900 ${
              frozenCount > 0 ? "bg-inherit" : ""
            }`}
          >
            <input
              type="checkbox"
              checked={selectedIds.has(load.id)}
              onChange={() => onToggleSelected(load.id)}
              aria-label={`Zaznacz zlecenie ${load.order_number ?? ""}`}
            />
          </td>
          {columns.map((column, index) => {
            const isEditing = editingCell?.id === load.id && editingCell.key === column.key;
            return (
              <td
                key={column.key}
                style={stickyCellStyle(index + 1, frozenCount, 1)}
                onClick={() => {
                  if (!isEditing) onStartEdit({ id: load.id, key: column.key });
                }}
                className={`whitespace-nowrap border-b border-zinc-100 px-2 py-1 text-zinc-800 dark:border-zinc-900 dark:text-zinc-200 ${
                  column.align === "right" ? "text-right tabular-nums" : ""
                } ${index + 1 <= frozenCount ? "bg-inherit" : ""} ${isEditing ? "p-0" : "cursor-text"}`}
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
          <td className="whitespace-nowrap border-b border-zinc-100 px-2 py-1 dark:border-zinc-900">
            <button
              type="button"
              onClick={() => onInvoice(load)}
              title={load.fakturownia_invoice_id ? `Faktura ${load.invoice_number ?? ""} wystawiona` : "Wystaw fakturę w Fakturowni"}
              className={`mr-1 rounded border px-2 py-0.5 text-[11px] ${
                load.fakturownia_invoice_id
                  ? "border-green-300 text-green-700 dark:border-green-800 dark:text-green-400"
                  : "border-zinc-300 text-zinc-600 hover:border-zinc-500 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              {load.fakturownia_invoice_id ? "Faktura ✓" : "Faktura"}
            </button>
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
  // Brutto = towar + tara kontenera — zmiana wagi netto albo typu kontenera przelicza brutto
  // (ręczny tekst typu "według armatora" zostaje).
  if (load && (column.key === "net_weight_kg" || column.key === "container_size")) {
    const net = column.key === "net_weight_kg" ? (typeof value === "number" ? value : null) : load.net_weight_kg;
    const size = column.key === "container_size" ? (typeof value === "string" ? value : null) : load.container_size;
    const gross = computeGrossWeightKg(net, size);
    if (gross !== null && canOverwriteGrossWeight(load.gross_weight)) patch.gross_weight = String(gross);
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
