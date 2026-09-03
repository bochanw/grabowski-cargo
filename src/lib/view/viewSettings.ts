import { COLUMNS, type ColumnDef } from "@/components/zestawienie/columns";
import type { Load } from "@/types/load";

/**
 * Konfiguracja widoku Zestawienia — per użytkownik, trzymana w public.user_view_settings
 * (migracja 0007). Właściciel: "dałbym użytkownikom możliwość ręcznego ustalania co chcą
 * widzieć bez narzucania".
 *
 * `order` to jednocześnie lista kolumn ZNANYCH w chwili zapisu — patrz `resolveColumns`.
 */
export interface ViewSettings {
  /** Klucze kolumn w kolejności ustawionej przez użytkownika (widoczne i ukryte razem). */
  order: string[];
  /** Które z nich są ukryte. */
  hidden: string[];
  /** Ile pierwszych WIDOCZNYCH kolumn zostaje przyklejonych do lewej przy przewijaniu w bok. */
  frozen: number;
  /**
   * Szerokość kolumny w pikselach, klucz kolumny → px. BRAK wpisu znaczy "auto" — kolumna jest
   * tak szeroka, jak jej najdłuższa wartość (tak działała cała tabela, zanim doszło zwężanie).
   * Klient: widok jest za szeroki — zwężenie musi zostawiać ślad per użytkownik, jak reszta widoku.
   */
  widths: Record<string, number>;
}

const ALL_KEYS = COLUMNS.map((column) => String(column.key));

/** Poniżej ~48 px zostaje sam wielokropek, powyżej ~640 px zwężanie przestaje mieć sens. */
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 640;
/** Szerokość dla "Zwęź wszystkie" — mieści datę, numer kontenera i większość nazw miejscowości. */
export const COMPACT_COLUMN_WIDTH = 110;

export function clampColumnWidth(px: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, px)));
}

// Właściciel: "daj każdemu wszystko i najwyżej będziemy sobie ręcznie wyłączać" — domyślnie
// KOMPLET kolumn, w kolejności z kodu. Ukrywanie to świadoma decyzja użytkownika, nie stan startowy.
export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  order: ALL_KEYS,
  hidden: [],
  // Świadomie 0: zamrożenie kolumn zmienia układ tabeli, więc nie narzucamy go nikomu z góry —
  // każdy ustawia sobie N w oknie "Widok".
  frozen: 0,
  // Domyślnie żadna kolumna nie ma narzuconej szerokości — dopóki nikt nic nie zwęzi, tabela
  // wygląda dokładnie jak dotąd.
  widths: {},
};

/**
 * jsonb z bazy może zawierać cokolwiek (starsza wersja appki, ręczna edycja w SQL Editor), a
 * `order`/`hidden` sterują renderowaniem tabeli — stąd twarda normalizacja przed użyciem.
 * Nieznane klucze zostawiamy w `order`: kolumna czasowo usunięta z kodu i przywrócona wraca
 * wtedy na swoje miejsce zamiast na koniec listy.
 */
export function normalizeViewSettings(raw: unknown): ViewSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_VIEW_SETTINGS;
  const source = raw as Record<string, unknown>;
  const order = stringArray(source.order);
  const hidden = stringArray(source.hidden);
  const frozen = typeof source.frozen === "number" && Number.isFinite(source.frozen) ? Math.max(0, Math.floor(source.frozen)) : 0;
  const widths = widthMap(source.widths);
  // Pusty `order` = wiersz z domyślnym '{}' albo śmieci — traktujemy jak brak konfiguracji.
  if (order.length === 0) return { ...DEFAULT_VIEW_SETTINGS, frozen, widths };
  return { order: unique(order), hidden: unique(hidden), frozen, widths };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Szerokości z jsonb-a lądują wprost w stylu tabeli, więc przycinamy je do sensownego zakresu tu,
 * a nie przy renderowaniu: wiersz zapisany starszą wersją appki (albo ręcznie w SQL Editor) nie ma
 * prawa rozjechać widoku, a 0 albo NaN w `width` potrafi zwinąć kolumnę do zera.
 */
function widthMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) result[key] = clampColumnWidth(raw);
  }
  return result;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export interface ResolvedView {
  /** Wszystkie znane kolumny w kolejności użytkownika — do listy w oknie konfiguracji. */
  ordered: ColumnDef[];
  /** Tylko widoczne, w tej samej kolejności — to renderuje tabela. */
  visible: ColumnDef[];
  /** Ile pierwszych z `visible` przykleić do lewej (przycięte do liczby widocznych). */
  frozen: number;
  /** Narzucone szerokości (px) — kolumny bez wpisu zostają "auto". */
  widths: Record<string, number>;
  isHidden: (key: keyof Load) => boolean;
}

/**
 * Konfiguracja użytkownika + aktualna lista kolumn w kodzie → co i w jakiej kolejności pokazać.
 *
 * Kolumna dodana w kodzie PO zapisaniu konfiguracji (brak jej w `order`) ląduje na końcu listy i
 * jest widoczna — zgodnie z zasadą "każdy dostaje wszystko, wyłącza sobie sam". Nowe pole ma się
 * pokazać, a nie czekać, aż ktoś odkryje je w oknie "Widok".
 */
export function resolveColumns(settings: ViewSettings | null): ResolvedView {
  const effective = settings ?? DEFAULT_VIEW_SETTINGS;
  const byKey = new Map(COLUMNS.map((column) => [String(column.key), column]));
  const knownAtSave = new Set(effective.order);
  const hidden = new Set(effective.hidden);

  const ordered: ColumnDef[] = [];
  for (const key of effective.order) {
    const column = byKey.get(key);
    if (column) ordered.push(column);
  }
  for (const column of COLUMNS) {
    if (!knownAtSave.has(String(column.key))) ordered.push(column);
  }

  const isHidden = (key: keyof Load) => hidden.has(String(key));
  const visible = ordered.filter((column) => !isHidden(column.key));
  return {
    ordered,
    visible,
    frozen: Math.min(effective.frozen, visible.length),
    widths: effective.widths ?? {},
    isHidden,
  };
}

/** Konfiguracja do zapisu po zmianie widoczności/kolejności — zawsze z pełną, aktualną listą kolumn. */
export function toStoredSettings(
  ordered: ColumnDef[],
  hiddenKeys: Set<string>,
  frozen: number,
  widths: Record<string, number>
): ViewSettings {
  return {
    order: ordered.map((column) => String(column.key)),
    hidden: ordered.map((column) => String(column.key)).filter((key) => hiddenKeys.has(key)),
    frozen: Math.max(0, Math.floor(frozen)),
    widths,
  };
}

/** Nowa szerokość jednej kolumny; `null` = z powrotem "auto" (szerokość z treści). */
export function withColumnWidth(settings: ViewSettings, key: string, width: number | null): ViewSettings {
  const widths = { ...settings.widths };
  if (width === null) delete widths[key];
  else widths[key] = clampColumnWidth(width);
  return { ...settings, widths };
}

/**
 * "Zwęź wszystkie" — jedno kliknięcie zamiast przeciągania kilkudziesięciu kolumn (to jest ta
 * skarga klienta w całości). Kolumna węższa od zadanej zostaje, jaka była: guzik ZWĘŻA, więc nie
 * ma prawa niczego rozszerzyć i cofnąć komuś jego własnej, ciaśniejszej roboty.
 */
export function withCompactWidths(settings: ViewSettings, keys: string[], width: number): ViewSettings {
  const target = clampColumnWidth(width);
  const widths = { ...settings.widths };
  for (const key of keys) {
    const current = widths[key];
    if (current === undefined || current > target) widths[key] = target;
  }
  return { ...settings, widths };
}

/** Wszystkie kolumny z powrotem na "auto". */
export function withAutoWidths(settings: ViewSettings): ViewSettings {
  return { ...settings, widths: {} };
}

/** Przesunięcie kolumny o jedno miejsce w górę/dół listy (kolejność ustawiamy strzałkami). */
export function moveColumn(ordered: ColumnDef[], index: number, delta: number): ColumnDef[] {
  const target = index + delta;
  if (index < 0 || index >= ordered.length || target < 0 || target >= ordered.length) return ordered;
  const next = [...ordered];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}
