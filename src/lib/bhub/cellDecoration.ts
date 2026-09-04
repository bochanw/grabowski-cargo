// Wygląd komórek zależny od danych z Baltic Hub — JEDNO miejsce dla trzech kolumn Zestawienia:
//
//   "Status BHub"  → dwie litery + kolor tła (SS czerwony, ZS niebieski, SO żółty, SP pomarańczowy,
//                    ZP szary),
//   "Wielkość"     → pogrubienie, gdy długość z ISO terminala pokrywa się ze zleceniem; alarm, gdy nie,
//   "Gestia"       → pogrubienie, gdy armator terminala zgadza się z gestią; alarm, gdy nie.
//
// Dlaczego osobny moduł, a nie warunki w JSX tabeli: reguły są testowalne bez renderowania i nie
// giną w 900 liniach ZestawienieTable. Funkcja zwraca też `title` — alarm bez wyjaśnienia, CO się
// nie zgadza, jest tylko czerwonym tłem, po którym i tak trzeba wejść na stronę terminala.

import type { Load } from "@/types/load";
import { BHUB_STATUS_CLASSES, BHUB_STATUS_LABELS, isBhubStatus } from "./status";
import { compareIsoFamily, describeIsoType } from "./isoType";
import { containerWarnings, jestNadpisywana, wartoscZeZlecenia, type NadpisywanaKolumna } from "./checks";

export interface CellDecoration {
  /** Treść do wyświetlenia zamiast surowej wartości pola (null = zostaw domyślną). */
  text?: string;
  /** Dodatkowe klasy dla bloku z treścią komórki. */
  className: string;
  title?: string;
  /** Czy przed wartością ma stanąć trójkącik ostrzegawczy. */
  alarm?: boolean;
}

const MATCH_CLASS = "font-bold";
// Alarm musi być widoczny bez czytania: pogrubienie + czerwień + znak ostrzegawczy przed wartością.
const ALARM_CLASS = "font-bold text-red-700 bg-red-50 dark:bg-red-950/60 dark:text-red-300";
// Uwaga o samym kontenerze (Time Out, waga celna) — trójkącik, ale BEZ czerwieni: to nie jest
// sprzeczność z naszym zleceniem, tylko coś, o czym mówi terminal i co dyspozytor ma zobaczyć.
const UWAGA_CLASS = "font-bold text-amber-700 dark:text-amber-400";

function checkedAtNote(load: Pick<Load, "bhub_checked_at" | "bhub_error">, now: Date): string {
  if (load.bhub_error) return `Ostatnie sprawdzenie nie powiodło się: ${load.bhub_error}`;
  if (!load.bhub_checked_at) return "Jeszcze nie sprawdzano w terminalu";
  const checked = new Date(load.bhub_checked_at);
  if (Number.isNaN(checked.getTime())) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - checked.getTime()) / 60_000));
  if (minutes < 1) return "Sprawdzono przed chwilą";
  if (minutes < 60) return `Sprawdzono ${minutes} min temu`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Sprawdzono ${hours} godz. temu`;
  return `Sprawdzono ${checked.toLocaleString("pl-PL")}`;
}

type DecoratedLoad = Pick<
  Load,
  | "bhub_status"
  | "bhub_status_raw"
  | "bhub_iso_type"
  | "bhub_shipping_line"
  | "bhub_gross_weight_kg"
  | "bhub_net_weight_kg"
  | "bhub_commodity_weight_kg"
  | "bhub_time_out"
  | "bhub_checked_at"
  | "bhub_error"
  | "container_size"
  | "shipping_line"
  | "net_weight_kg"
  | "gross_weight"
  | "terminal_conflicts"
>;

/**
 * Ozdoba komórki dla danej kolumny — null, gdy kolumna nie ma nic wspólnego z Baltic Hub.
 * `now` wstrzykiwane, żeby "sprawdzono X min temu" dało się przetestować bez czekania.
 */
export function bhubCellDecoration(
  load: DecoratedLoad,
  columnKey: string,
  now: Date = new Date()
): CellDecoration | null {
  if (columnKey === "bhub_status") return statusDecoration(load, now);
  if (columnKey === "container_number") return containerDecoration(load, now);
  if (jestNadpisywana(columnKey)) return nadpisanaDecoration(load, columnKey, now);
  return null;
}

/**
 * Numer kontenera — tu wiszą uwagi o SAMYM kontenerze, nie o polu zlecenia: niepusty „Time Out"
 * i rozjazd wagi celnej z wagą towaru. Numer jest jedynym miejscem, przy którym obie mają sens,
 * bo nie dotyczą żadnej konkretnej rubryki zlecenia.
 */
function containerDecoration(load: DecoratedLoad, now: Date): CellDecoration | null {
  const uwagi = containerWarnings(load);
  if (uwagi.length === 0) return null;
  return {
    className: UWAGA_CLASS,
    alarm: true,
    title: [...uwagi.map((u) => u.text), checkedAtNote(load, now)].filter(Boolean).join("\n"),
  };
}

function statusDecoration(load: DecoratedLoad, now: Date): CellDecoration {
  const note = checkedAtNote(load, now);
  const status = load.bhub_status;

  if (isBhubStatus(status)) {
    const extras = [BHUB_STATUS_LABELS[status]];
    if (load.bhub_iso_type) extras.push(`ISO: ${describeIsoType(load.bhub_iso_type)}`);
    if (load.bhub_shipping_line) extras.push(`Armator wg terminala: ${load.bhub_shipping_line}`);
    if (load.bhub_gross_weight_kg !== null) extras.push(`Waga brutto z terminala: ${load.bhub_gross_weight_kg} kg`);
    if (note) extras.push(note);
    return {
      // Kolor niesie informację, więc siedzi na całej komórce, a nie na samym napisie.
      className: `${BHUB_STATUS_CLASSES[status]} text-center font-bold tracking-wide`,
      title: extras.join("\n"),
    };
  }

  // Terminal powiedział coś, czego jeszcze nie umiemy nazwać (właściciel: "z czasem będę Ci
  // tłumaczył co będzie oznaczał każdy status"). Pokazujemy jego słowa BEZ koloru — kolor
  // znaczyłby, że wiemy, co to jest.
  if (load.bhub_status_raw) {
    return {
      text: load.bhub_status_raw,
      className: "italic text-zinc-500 dark:text-zinc-400",
      title: [`Status z terminala, jeszcze bez przypisanego kodu: „${load.bhub_status_raw}”`, note]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (load.bhub_error) {
    return { text: "—", className: "text-red-600 dark:text-red-400", title: note };
  }
  return { className: "", title: note };
}

/**
 * Kolumna NADPISYWANA przez terminal (waga brutto, waga netto, wielkość, gestia).
 *
 * Po nadpisaniu w komórce stoi już liczba terminala, więc porównanie „komórka kontra terminal"
 * zawsze wychodziłoby zgodnie — i alarm, o który prosił właściciel, nigdy by się nie zapalił.
 * Rozbieżność niesie `terminal_conflicts`: co mówiło ZLECENIE, zanim terminal to nadpisał
 * (migracja 0032). Wpis kasuje dopiero ręczna poprawka tej kolumny.
 */
function nadpisanaDecoration(load: DecoratedLoad, columnKey: NadpisywanaKolumna, now: Date): CellDecoration | null {
  const note = checkedAtNote(load, now);
  const zlecenie = wartoscZeZlecenia(load, columnKey);
  const nazwa = ETYKIETY_KOLUMN[columnKey];

  if (zlecenie !== null) {
    return {
      className: ALARM_CLASS,
      alarm: true,
      title:
        `NIEZGODNOŚĆ: ${nazwa} ze zlecenia to „${zlecenie}", a terminal podał to, co stoi w komórce ` +
        `— i to jego wartość została wpisana.\nPopraw komórkę, jeśli rację ma zlecenie; ręczna ` +
        `poprawka gasi to ostrzeżenie.\n${note}`,
    };
  }

  // Bez rozbieżności: pogrubiamy tylko wtedy, gdy terminal FAKTYCZNIE potwierdził tę kolumnę.
  const potwierdzone =
    columnKey === "gross_weight"
      ? load.bhub_gross_weight_kg !== null
      : columnKey === "net_weight_kg"
        ? load.bhub_net_weight_kg !== null
        : columnKey === "container_size"
          ? Boolean(load.bhub_iso_type)
          : Boolean(load.bhub_shipping_line);
  if (!potwierdzone) return null;

  // Zgodna długość, ale inny rodzaj kontenera (zlecenie na open top, terminal ma zwykły) —
  // świadomie NIE alarm (właściciel zawęził regułę do długości), tylko dopisek w dymku.
  const rodzaj =
    columnKey === "container_size" && compareIsoFamily(load.bhub_iso_type, load.container_size) === "mismatch"
      ? `\nUWAGA: rodzaj kontenera się różni — terminal: ${describeIsoType(load.bhub_iso_type)}.`
      : "";

  return { className: MATCH_CLASS, title: `${nazwa} potwierdzona przez terminal.${rodzaj}\n${note}` };
}

const ETYKIETY_KOLUMN: Record<NadpisywanaKolumna, string> = {
  gross_weight: "Waga brutto",
  net_weight_kg: "Waga netto",
  container_size: "Wielkość",
  shipping_line: "Gestia",
};

/** Znak ostrzegawczy dopisywany przed wartością w komórce z alarmem. */
export const ALARM_PREFIX = "⚠ ";

export function isAlarm(decoration: CellDecoration | null): boolean {
  return decoration?.alarm === true;
}
