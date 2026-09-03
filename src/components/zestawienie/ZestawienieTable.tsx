"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Load, Direction } from "@/types/load";
import { useDeleteLoad, useUpdateLoad } from "@/hooks/useLoads";
import { PICKUP_LOCATIONS } from "@/lib/orderTemplates/pickupLocations";
import { EMPTY_FLEET, useFleet, withCurrentOption, type Fleet } from "@/lib/fleet/fleetStore";
import { canOverwriteGrossWeight, computeGrossWeightKg } from "@/lib/containers/tare";
import { splitBaf } from "@/lib/invoice/baf";
import { shippingLineForNotes } from "@/lib/loads/leasing";
import { loadSearchText, matchesQuery } from "@/lib/search/loadSearch";
import { ALARM_PREFIX, bhubCellDecoration, isAlarm } from "@/lib/bhub/cellDecoration";
import { BHUB_STATUSES, BHUB_STATUS_LABELS } from "@/lib/bhub/status";
import { shouldTrackLoad } from "@/lib/bhub/schedule";
import { useBhubCheck } from "@/hooks/useBhubCheck";
import { useBhubAgent } from "@/hooks/useBhubAgent";
import { opisOstatniegoSprawdzenia } from "@/lib/bhub/agentStatus";
import { type ColumnDef } from "./columns";
import { ImportOrderDialog } from "./ImportOrderDialog";
import { ActivityLogPanel } from "./ActivityLogPanel";
import { SkrzynkaPanel } from "./SkrzynkaPanel";
import { useEmailInbox } from "@/hooks/useEmailInbox";
import { ContractorsDialog } from "./ContractorsDialog";
import { LoadDocumentsDialog } from "./LoadDocumentsDialog";
import { removeStoredFilesForLoad, useLoadDocuments } from "@/hooks/useLoadDocuments";
import { InvoiceDialog } from "./InvoiceDialog";
import { ViewSettingsDialog } from "./ViewSettingsDialog";
import { useContractors } from "@/hooks/useContractors";
import { useSaveViewSettings, useViewSettings } from "@/hooks/useViewSettings";
import {
  clampColumnWidth,
  resolveColumns,
  toStoredSettings,
  withColumnWidth,
  type ViewSettings,
} from "@/lib/view/viewSettings";
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

/**
 * Zwężanie kolumn (klient: "obecny widok jest za szeroki"). Szerokość każdej kolumny siedzi w
 * zmiennej CSS na elemencie <table>, a komórki czytają ją przez var() — brak zmiennej znaczy
 * "auto", czyli dokładnie to, co tabela robiła zawsze (szerokość z najdłuższej wartości).
 *
 * Zmienna, a nie stan Reacta, z tego samego powodu co przy zamrożonych kolumnach: w trakcie
 * przeciągania uchwytu ustawiamy ją wprost na elemencie, więc kilkadziesiąt razy na sekundę
 * przerysowuje się sama tabela w przeglądarce, a nie kilkaset komórek w Reakcie.
 *
 * Szerokość idzie na WEWNĘTRZNY <div>, nie na komórkę: dla `table-layout: auto` przeglądarka
 * traktuje `width` komórki tylko jako sugestię i rozpycha ją do treści (a `max-width` na komórce
 * w tym trybie w ogóle nie działa). Blok o zadanej szerokości z `overflow: hidden` narzuca
 * kolumnie szerokość twardo i przycina tekst wielokropkiem.
 */
function columnWidthVar(key: string): string {
  return `--cw-${key}`;
}

function cellContentStyle(key: string): CSSProperties {
  return { width: `var(${columnWidthVar(key)}, auto)` };
}

/**
 * Wypełnienie komórki siedzi na tym wewnętrznym bloku, a nie na <td>/<th> (które mają `p-0`):
 * dzięki temu zapisana szerokość to szerokość CAŁEJ kolumny — ta sama liczba niezależnie od tego,
 * czy komórka jest w trybie odczytu, czy z otwartym edytorem.
 */
const CELL_PADDING = "px-2 py-1";

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
  | { kind: "invoice"; loadIds: string[] }
  | { kind: "documents"; load: Load };

export function ZestawienieTable({ loads }: { loads: Load[] }) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isInboxOpen, setIsInboxOpen] = useState(false);
  // Licznik przy guziku „Skrzynka" — zlecenie z maila ma się rzucać w oczy samo, bez
  // zaglądania do panelu. Hook jest tu, a nie w panelu, bo licznik musi żyć także zamknięty.
  const { data: inboxMessages } = useEmailInbox();
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

  // Załączniki (oryginalne PDF-y zlecenia, POD/CMR, inne) — licznik przy każdym wierszu.
  const { data: loadDocuments = [] } = useLoadDocuments();
  const documentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const document of loadDocuments) counts.set(document.load_id, (counts.get(document.load_id) ?? 0) + 1);
    return counts;
  }, [loadDocuments]);

  // Status kontenerów z Baltic Hub. Odpytuje ROZSZERZENIE do Chrome w przeglądarce dyspozytora
  // (terminal odrzuca ruch z serwerowni — Cloudflare i reCAPTCHA), cyklicznie co 15 minut oraz
  // na żądanie: zaraz po zapisaniu zlecenia z podjęciem z BHub i z guzika w pasku.
  const { checking: checkingIds, check: checkBhub, error: bhubError, extension } = useBhubCheck();
  const { data: bhubAgent } = useBhubAgent();
  const bhubStatus = useMemo(() => opisOstatniegoSprawdzenia(bhubAgent, extension), [bhubAgent, extension]);
  const trackedIds = useMemo(() => loads.filter(shouldTrackLoad).map((load) => load.id), [loads]);

  // Sprawdzenie zaraz po zapisaniu zlecenia (właściciel: "po wgraniu zlecenia które pobieramy
  // z BHub program wchodzi na stronę i sprawdza status"). Świeżo wstawionego rekordu może jeszcze
  // nie być na liście (Realtime ma opóźnienie) — wtedy wołamy i tak, bo to najczęstszy przypadek,
  // a funkcja brzegowa i tak sprawdza, czy zlecenie podlega śledzeniu.
  const checkAfterSave = useCallback(
    async (loadId: string) => {
      const saved = loads.find((load) => load.id === loadId);
      if (saved && !shouldTrackLoad(saved)) return;
      await checkBhub([loadId]);
    },
    [loads, checkBhub]
  );

  // Widok jest PER UŻYTKOWNIK (Supabase, migracja 0007): które kolumny, w jakiej kolejności i ile
  // pierwszych zamrożonych. Dopóki ustawienia się wczytują, `resolveColumns(null)` daje widok
  // domyślny — tabela nie miga pustymi kolumnami.
  const { data: viewSettings = null } = useViewSettings();
  const saveViewSettings = useSaveViewSettings();
  const view = useMemo(() => resolveColumns(viewSettings), [viewSettings]);
  const columns = view.visible;
  const frozenCount = view.frozen;

  // Szerokości kolumn → zmienne CSS na <table>. Kolumna bez wpisu nie dostaje zmiennej, więc
  // var(--cw-…, auto) zwraca "auto" i kolumna zachowuje się jak przed tą zmianą.
  const widthVars = useMemo(() => {
    const style: Record<string, string> = {};
    for (const [key, px] of Object.entries(view.widths)) style[columnWidthVar(key)] = `${px}px`;
    return style as CSSProperties;
  }, [view.widths]);

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
  }, [applyFrozenOffsets, columns, visibleLoads.length, view.widths]);

  // Zmierzone szerokości widocznych kolumn — okno "Widok" potrzebuje ich do "Zwęź wszystkie":
  // bez pomiaru nie da się odróżnić kolumny szerokiej (do zwężenia) od takiej, która z natury ma
  // 50 px i wpisanie jej 110 px ROZSZERZYŁOBY tabelę zamiast ją zwęzić.
  const measureColumnWidths = useCallback(() => {
    const measured: Record<string, number> = {};
    columns.forEach((column, index) => {
      const width = headerRefs.current[index + 1]?.getBoundingClientRect().width;
      if (width) measured[String(column.key)] = Math.round(width);
    });
    return measured;
  }, [columns]);

  // Zwężanie kolumny: zapis idzie do TEJ SAMEJ konfiguracji per użytkownik co kolumny i ich
  // kolejność (public.user_view_settings) — szerokość jedzie za człowiekiem na inne stanowisko.
  const saveWidth = useCallback(
    async (key: string, width: number | null) => {
      const hiddenKeys = new Set(
        view.ordered.filter((column) => view.isHidden(column.key)).map((column) => String(column.key))
      );
      const base: ViewSettings = toStoredSettings(view.ordered, hiddenKeys, view.frozen, view.widths);
      const error = await saveViewSettings(withColumnWidth(base, key, width));
      // Udany zapis sprząta po poprzednim nieudanym — inaczej w pasku wisiałby komunikat o
      // błędzie, którego już nie ma (złapane testem w przeglądarce).
      if (!error) {
        setSaveError(null);
        return;
      }
      setSaveError(`Nie udało się zapisać szerokości kolumny: ${error}`);
      // Nieudany zapis cofa konfigurację w pamięci, ale zmienną ustawioną wprost w trakcie
      // przeciągania musimy cofnąć sami — inaczej kolumna zostałaby zwężona tylko na tym ekranie,
      // do najbliższego odświeżenia, mimo komunikatu o błędzie.
      const previous = view.widths[key];
      const table = tableRef.current;
      if (!table) return;
      if (previous === undefined) table.style.removeProperty(columnWidthVar(key));
      else table.style.setProperty(columnWidthVar(key), `${previous}px`);
    },
    [saveViewSettings, view]
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>, column: ColumnDef, headerIndex: number) => {
      // Drugi klik dubletu pomijamy — od resetu do "auto" jest onDoubleClick na uchwycie.
      if (event.button !== 0 || event.detail > 1) return;
      event.preventDefault();
      event.stopPropagation();
      const table = tableRef.current;
      const header = headerRefs.current[headerIndex];
      if (!table || !header) return;

      const key = String(column.key);
      const startX = event.clientX;
      // Szerokość startowa z wyrenderowanego nagłówka: kolumna "auto" nie ma zapisanej liczby, a
      // przeciąganie ma się zaczynać dokładnie tam, gdzie stoi krawędź.
      const startWidth = header.getBoundingClientRect().width;
      let latest = clampColumnWidth(startWidth);
      let moved = false;

      const onMove = (moveEvent: PointerEvent) => {
        moved = true;
        latest = clampColumnWidth(startWidth + moveEvent.clientX - startX);
        table.style.setProperty(columnWidthVar(key), `${latest}px`);
        // Zamrożone kolumny stoją na zmierzonych odsunięciach — po zwężeniu jednej z nich muszą
        // się przesunąć razem z nią, a nie dopiero po puszczeniu myszy.
        applyFrozenOffsets();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        // Sam klik w uchwyt (bez ruchu) niczego nie zapisuje — inaczej kolumna "auto" dostawałaby
        // sztywną szerokość przez przypadkowe muśnięcie krawędzi.
        if (moved) void saveWidth(key, latest);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      // Bez tego ruch myszą zaznacza treść tabeli, a kursor mruga nad każdą mijaną komórką.
      document.body.style.setProperty("cursor", "col-resize");
      document.body.style.setProperty("user-select", "none");
    },
    [applyFrozenOffsets, saveWidth]
  );

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
    // Wiersze dokumentów znikną same (`on delete cascade`), ale pliki w Storage nie — Postgres do
    // niego nie sięga, więc kasujemy je zanim zniknie zlecenie (potem nie będzie po czym ich znaleźć).
    await removeStoredFilesForLoad(load.id);
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
        {saveError || bhubError ? (
          <span className="text-xs text-red-600">{saveError ?? bhubError}</span>
        ) : (
          selectedLoads.length === 0 && (
            <span className="hidden text-xs text-zinc-400 xl:inline">Kliknij komórkę, żeby edytować — Enter zapisuje, Esc anuluje.</span>
          )
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Odpytywanie idzie cyklicznie z rozszerzenia (co 15 min); ten guzik jest na "sprawdź
              teraz". Obok STAN ODCZYTU: odkąd sprawdza cudza przeglądarka, zastój ma być widać —
              inaczej dyspozytor patrzyłby na wczorajszy status przekonany, że jest dzisiejszy. */}
          <span
            title={bhubStatus.tytul}
            className={`hidden text-xs xl:inline ${
              bhubStatus.ton === "blad"
                ? "text-red-600"
                : bhubStatus.ton === "uwaga"
                  ? "text-amber-600"
                  : "text-zinc-400"
            }`}
          >
            {bhubStatus.tekst}
          </span>
          <button
            type="button"
            disabled={trackedIds.length === 0 || checkingIds.size > 0}
            onClick={() => void checkBhub(trackedIds)}
            title={
              trackedIds.length === 0
                ? "Nie ma kontenerów do sprawdzenia (podjęcie z BHub, znany numer, status inny niż ZP)"
                : `Sprawdź teraz statusy w Baltic Hub. ${bhubStatus.tytul}`
            }
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-400 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400"
          >
            Statusy BHub{trackedIds.length > 0 ? ` (${trackedIds.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setDialog({ kind: "contractors" })}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
          >
            Kontrahenci
          </button>
          <button
            type="button"
            onClick={() => setIsInboxOpen((open) => !open)}
            title="Zlecenia odczytane ze skrzynki firmowej, czekające na zatwierdzenie"
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              isInboxOpen
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
            }`}
          >
            Skrzynka{inboxMessages && inboxMessages.length > 0 ? ` (${inboxMessages.length})` : ""}
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
        <ImportOrderDialog recentLoads={recentLoads} onSaved={checkAfterSave} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "contractors" && <ContractorsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "view" && (
        <ViewSettingsDialog measureColumnWidths={measureColumnWidths} onClose={() => setDialog(null)} />
      )}
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
      {dialog?.kind === "documents" && (
        <LoadDocumentsDialog load={dialog.load} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "attach" && (
        <ImportOrderDialog
          mode="attach"
          existingLoad={dialog.load}
          recentLoads={recentLoads.filter((l) => l.id !== dialog.load.id)}
          onSaved={checkAfterSave}
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
        <table
          ref={tableRef}
          style={widthVars}
          className="w-full min-w-max border-separate border-spacing-0 text-xs"
        >
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
                  className={`relative whitespace-nowrap border-b border-zinc-200 bg-zinc-100 p-0 text-left font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 ${
                    column.align === "right" ? "text-right" : ""
                  }`}
                >
                  <div
                    style={cellContentStyle(String(column.key))}
                    className="overflow-hidden text-ellipsis px-2 py-1.5"
                    title={view.widths[String(column.key)] ? column.label : undefined}
                  >
                    {column.label}
                  </div>
                  {/* Uchwyt na prawej krawędzi nagłówka — jak w Excelu: przeciągnij, żeby zwęzić,
                      dwuklik wraca do szerokości z treści. Leży na wypełnieniu komórki, więc nie
                      zabiera miejsca etykiecie. */}
                  <span
                    onPointerDown={(event) => startResize(event, column, index + 1)}
                    onDoubleClick={() => void saveWidth(String(column.key), null)}
                    onClick={(event) => event.stopPropagation()}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Zmień szerokość kolumny ${column.label}`}
                    title="Przeciągnij, żeby zmienić szerokość. Dwuklik = dopasuj do treści."
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none select-none hover:bg-blue-400/70"
                  />
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
                widths={view.widths}
                fleet={fleet}
                contractors={contractors}
                contractorNames={contractorNames}
                documentCounts={documentCounts}
                checkingIds={checkingIds}
                editingCell={editingCell}
                onStartEdit={setEditingCell}
                onCancelEdit={() => setEditingCell(null)}
                onCommit={commitCell}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
                onAttach={(load) => setDialog({ kind: "attach", load })}
                onInvoice={(load) => setDialog({ kind: "invoice", loadIds: [load.id] })}
                onDocuments={(load) => setDialog({ kind: "documents", load })}
                onDelete={handleDelete}
              />
            ))}
          </tbody>
        </table>
      </div>
      {isInboxOpen && <SkrzynkaPanel onClose={() => setIsInboxOpen(false)} loads={loads} />}
      {isHistoryOpen && <ActivityLogPanel onClose={() => setIsHistoryOpen(false)} />}
      </div>
    </div>
  );
}

interface RowHandlers {
  /** Ile pierwszych kolumn jest przyklejonych do lewej — patrz stickyCellStyle. 0 = żadna. */
  frozenCount: number;
  /** Które kolumny mają narzuconą szerokość — tylko te mogą przyciąć wartość (i tylko tam ma
   *  sens dymek z pełną treścią). */
  widths: Record<string, number>;
  fleet: Fleet;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  contractors: Contractor[];
  contractorNames: Map<string, string>;
  /** Ile dokumentów wisi przy zleceniu — licznik na guziku "Dokumenty". */
  documentCounts: Map<string, number>;
  /** Zlecenia, dla których trwa właśnie sprawdzanie statusu w Baltic Hub (znaczek przy kontenerze). */
  checkingIds: ReadonlySet<string>;
  editingCell: EditingCell | null;
  onStartEdit: (cell: EditingCell) => void;
  onCancelEdit: () => void;
  onCommit: (load: Load, column: ColumnDef, raw: string) => void;
  onAttach: (load: Load) => void;
  onInvoice: (load: Load) => void;
  onDocuments: (load: Load) => void;
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
  widths,
  fleet,
  selectedIds,
  onToggleSelected,
  contractors,
  contractorNames,
  documentCounts,
  checkingIds,
  editingCell,
  onStartEdit,
  onCancelEdit,
  onCommit,
  onAttach,
  onInvoice,
  onDocuments,
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
            // Kolor statusu z Baltic Hub, pogrubienie przy zgodnym ISO/gestii, alarm przy
            // niezgodnym — cała reguła siedzi w src/lib/bhub/cellDecoration.ts.
            const decoration = bhubCellDecoration(load, String(column.key));
            const text = decoration?.text ?? formatCell(load[column.key], column.kind, contractorNames);
            const alarm = isAlarm(decoration);
            // Znaczek przy numerze kontenera, gdy trwa sprawdzanie w terminalu.
            const spinning = column.key === "container_number" && checkingIds.has(load.id);
            return (
              <td
                key={column.key}
                style={stickyCellStyle(index + 1, frozenCount, 1)}
                onClick={() => {
                  if (!isEditing) onStartEdit({ id: load.id, key: column.key });
                }}
                className={`whitespace-nowrap border-b border-zinc-100 p-0 text-zinc-800 dark:border-zinc-900 dark:text-zinc-200 ${
                  column.align === "right" ? "text-right tabular-nums" : ""
                } ${index + 1 <= frozenCount ? "bg-inherit" : ""} ${isEditing ? "" : "cursor-text"}`}
              >
                {isEditing ? (
                  // Edytor dostaje tę samą szerokość co komórka, żeby wejście w edycję nie
                  // przesuwało reszty tabeli. Dolna granica (min-width) tylko po to, żeby dało się
                  // pisać w kolumnie zwężonej do kilkudziesięciu pikseli.
                  <div style={{ ...cellContentStyle(String(column.key)), minWidth: "6rem" }}>
                    <CellEditor
                      load={load}
                      column={column}
                      fleet={fleet}
                      contractors={contractors}
                      onCancel={onCancelEdit}
                      onCommit={(raw) => onCommit(load, column, raw)}
                    />
                  </div>
                ) : (
                  // title tylko przy narzuconej szerokości: tam wartość bywa przycięta i musi dać
                  // się obejrzeć bez rozszerzania kolumny. W kolumnie "auto" nic się nie przycina,
                  // a dymek nad każdą komórką byłby wyłącznie upierdliwy.
                  <div
                    style={cellContentStyle(String(column.key))}
                    // Dymek z Baltic Hub ma pierwszeństwo nad dymkiem "pełna wartość przyciętej
                    // komórki": alarm bez wyjaśnienia, co się nie zgadza, to samo czerwone tło.
                    title={decoration?.title ?? (widths[String(column.key)] ? text || undefined : undefined)}
                    className={`overflow-hidden text-ellipsis ${CELL_PADDING} ${decoration?.className ?? ""}`}
                  >
                    {alarm ? ALARM_PREFIX : ""}
                    {text}
                    {spinning && <BhubSpinner />}
                  </div>
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
              onClick={() => onDocuments(load)}
              title="Dokumenty zlecenia: oryginały PDF, POD/CMR, potwierdzenie dostawy, inne"
              className="mr-1 rounded border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600 hover:border-zinc-500 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              Dokumenty{documentCounts.get(load.id) ? ` (${documentCounts.get(load.id)})` : ""}
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

/**
 * Znaczek przy numerze kontenera na czas sprawdzania statusu w Baltic Hub (właściciel: "możesz
 * jakiś znaczek zostawić przy kontenerze jak będzie się odświeżał"). `aria-hidden` z tekstem obok
 * dla czytnika ekranu — sam kręcący się okrąg nic nie mówi.
 */
function BhubSpinner() {
  return (
    <span className="ml-1 inline-flex items-center align-middle" title="Sprawdzam status w Baltic Hub…">
      <span
        aria-hidden
        className="inline-block size-3 animate-spin rounded-full border border-zinc-400 border-t-transparent dark:border-zinc-500 dark:border-t-transparent"
      />
      <span className="sr-only">Sprawdzam status w Baltic Hub</span>
    </span>
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
    // Status z terminala normalnie ustawia bot, ale kolumna jest edytowalna jak każda inna —
    // lista, nie wolny tekst, bo w bazie stoi CHECK na te pięć kodów (literówka wpisana ręcznie
    // wróciłaby błędem zapisu zamiast się zapisać).
    case "bhub_status":
      return BHUB_STATUSES.map((code) => ({ value: code, label: `${code} — ${BHUB_STATUS_LABELS[code]}` }));
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
  // "Jeżeli w uwagach będzie Leasing, to wtedy gestia przestaw na Leasing" — także przy dopisaniu
  // uwagi wprost w tabeli, nie tylko przy odczycie dokumentu.
  if (load && column.key === "notes") {
    const line = shippingLineForNotes(typeof value === "string" ? value : null, load.shipping_line);
    if (line !== load.shipping_line) patch.shipping_line = line;
  }

  // BAF: stawka bazowa, procent i SUMA to jedna zależność (baza + BAF = suma), więc edycja
  // KTÓREJKOLWIEK z nich przelicza pozostałe — inaczej kolumny rozjechałyby się po pierwszej
  // ręcznej poprawce, a faktura poszłaby ze starym rozbiciem.
  if (load && (column.key === "freight_base_amount" || column.key === "baf_percentage" || column.key === "total_amount")) {
    const numberOrNull = (candidate: string | number | null) => (typeof candidate === "number" ? candidate : null);
    const percent = column.key === "baf_percentage" ? numberOrNull(value) : load.baf_percentage;
    // Edycja SUMY liczy w drugą stronę (od kwoty z BAF-em w dół), pozostałe — od bazy w górę.
    // Zmiana samego procentu przy pustej bazie też liczy od sumy: to jest wtedy jedyna znana kwota.
    const base = column.key === "freight_base_amount" ? numberOrNull(value) : load.freight_base_amount;
    const total = column.key === "total_amount" ? numberOrNull(value) : load.total_amount;
    const fromTotal = column.key === "total_amount" || base === null;
    const split = splitBaf(fromTotal ? total : base, percent, fromTotal);
    patch.freight_base_amount = split.base;
    patch.baf_amount = split.baf;
    patch.total_amount = split.total;
    // "Kwota" (blok Fakturowanie) trzyma kwotę do zafakturowania — ale po wystawieniu faktury jest
    // już zapisem tego, co faktycznie poszło do Fakturowni, więc wtedy jej nie ruszamy.
    if (!load.fakturownia_invoice_id) patch.invoice_amount = split.total;
  }

  // Brutto = towar + tara kontenera — zmiana wagi netto albo typu kontenera przelicza brutto
  // (ręczny tekst typu "według armatora" zostaje).
  if (load && (column.key === "net_weight_kg" || column.key === "container_size")) {
    const net = column.key === "net_weight_kg" ? (typeof value === "number" ? value : null) : load.net_weight_kg;
    const size = column.key === "container_size" ? (typeof value === "string" ? value : null) : load.container_size;
    const gross = computeGrossWeightKg(net, size);
    // Waga z Baltic Hub jest nadrzędna — gdy ją mamy, tara jej nie zastępuje.
    if (gross !== null && canOverwriteGrossWeight(load.gross_weight, load.bhub_gross_weight_kg)) {
      patch.gross_weight = String(gross);
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
