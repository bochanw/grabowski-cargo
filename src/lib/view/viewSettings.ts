import { COLUMNS, type ColumnBlock, type ColumnDef } from "@/components/zestawienie/columns";
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
}

/** Blok widoczny domyślnie — reszta (rozliczenie/fakturowanie/inne) to opcje do włączenia. */
const DEFAULT_VISIBLE_BLOCK: ColumnBlock = "ladunek";

const ALL_KEYS = COLUMNS.map((column) => String(column.key));

export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  order: ALL_KEYS,
  hidden: COLUMNS.filter((column) => column.block !== DEFAULT_VISIBLE_BLOCK).map((column) => String(column.key)),
  // Świadomie 0: zamrożenie kolumn zmienia układ tabeli, więc nie narzucamy go nikomu z góry —
  // każdy ustawia sobie N w oknie "Widok".
  frozen: 0,
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
  // Pusty `order` = wiersz z domyślnym '{}' albo śmieci — traktujemy jak brak konfiguracji.
  if (order.length === 0) return { ...DEFAULT_VIEW_SETTINGS, frozen };
  return { order: unique(order), hidden: unique(hidden), frozen };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
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
  isHidden: (key: keyof Load) => boolean;
}

/**
 * Konfiguracja użytkownika + aktualna lista kolumn w kodzie → co i w jakiej kolejności pokazać.
 *
 * Kolumna dodana w kodzie PO zapisaniu konfiguracji (brak jej w `order`) ląduje na końcu listy i
 * jest widoczna tylko, jeśli należy do bloku podstawowego. Bez tej reguły każde nowe pole samo
 * wskakiwałoby wszystkim do widoku — a widok jest tu świadomym wyborem dyspozytora.
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

  const isHidden = (key: keyof Load) => {
    const stringKey = String(key);
    if (hidden.has(stringKey)) return true;
    if (!knownAtSave.has(stringKey)) return byKey.get(stringKey)?.block !== DEFAULT_VISIBLE_BLOCK;
    return false;
  };

  const visible = ordered.filter((column) => !isHidden(column.key));
  return { ordered, visible, frozen: Math.min(effective.frozen, visible.length), isHidden };
}

/** Konfiguracja do zapisu po zmianie widoczności/kolejności — zawsze z pełną, aktualną listą kolumn. */
export function toStoredSettings(ordered: ColumnDef[], hiddenKeys: Set<string>, frozen: number): ViewSettings {
  return {
    order: ordered.map((column) => String(column.key)),
    hidden: ordered.map((column) => String(column.key)).filter((key) => hiddenKeys.has(key)),
    frozen: Math.max(0, Math.floor(frozen)),
  };
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
