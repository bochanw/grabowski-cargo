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
import { compareIsoFamily, compareIsoLength, describeIsoType, FAMILY_LABELS, orderSizeFamily } from "./isoType";
import { compareShippingLine } from "./shippingLine";
import { containerWarnings, formatKg, weightAgreement } from "./checks";

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
  if (!load.bhub_checked_at) return "Jeszcze nie sprawdzano w Baltic Hub";
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
  if (columnKey === "container_size") return sizeDecoration(load, now);
  if (columnKey === "shipping_line") return lineDecoration(load, now);
  if (columnKey === "container_number") return containerDecoration(load, now);
  if (columnKey === "gross_weight" || columnKey === "net_weight_kg") return weightDecoration(load, columnKey, now);
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

/**
 * Waga brutto i netto: terminal jest nadrzędny, więc zgodność POGRUBIAMY, a różnicę pokazujemy
 * trójkącikiem z obiema liczbami w dymku. Wartości ze zlecenia NIE nadpisujemy (patrz migracja
 * 0031) — inaczej nie byłoby już czego porównywać i różnica znikałaby razem z ostrzeżeniem.
 */
function weightDecoration(
  load: DecoratedLoad,
  columnKey: "gross_weight" | "net_weight_kg",
  now: Date
): CellDecoration | null {
  const { agreement, terminal, zlecenie } = weightAgreement(load, columnKey);
  if (terminal === null) return null;

  const nazwa = columnKey === "gross_weight" ? "brutto" : "netto";
  const note = checkedAtNote(load, now);
  if (agreement === "match") {
    return { className: MATCH_CLASS, title: `Waga ${nazwa} potwierdzona przez Baltic Hub (${formatKg(terminal)}).\n${note}` };
  }
  if (agreement === "unknown") {
    // Zlecenie nie ma tej wagi (albo ma tekst typu „według armatora"). Nie ma sprzeczności —
    // pokazujemy tylko, co mówi terminal, żeby dyspozytor wiedział, że jest skąd ją wziąć.
    return {
      className: "",
      title: `Baltic Hub podaje wagę ${nazwa}: ${formatKg(terminal)}.\n${note}`,
    };
  }
  return {
    className: ALARM_CLASS,
    alarm: true,
    title:
      `NIEZGODNOŚĆ wagi ${nazwa}: Baltic Hub podaje ${formatKg(terminal)}, a zlecenie ` +
      `${zlecenie === null ? "nic" : formatKg(zlecenie)}. Waga z terminala jest nadrzędna.\n${note}`,
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
      title: [`Status z Baltic Hub, jeszcze bez przypisanego kodu: „${load.bhub_status_raw}”`, note]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (load.bhub_error) {
    return { text: "—", className: "text-red-600 dark:text-red-400", title: note };
  }
  return { className: "", title: note };
}

function sizeDecoration(load: DecoratedLoad, now: Date): CellDecoration | null {
  const agreement = compareIsoLength(load.bhub_iso_type, load.container_size);
  if (agreement === "unknown") return null;

  const isoLabel = describeIsoType(load.bhub_iso_type);
  const note = checkedAtNote(load, now);
  if (agreement === "match") {
    // Zgodna długość, ale inny rodzaj (np. zlecenie na open top, terminal ma zwykły) — świadomie
    // NIE alarm (właściciel zawęził regułę do długości), tylko dopisek w dymku.
    const orderFamily = orderSizeFamily(load.container_size);
    const familyNote =
      orderFamily && compareIsoFamily(load.bhub_iso_type, load.container_size) === "mismatch"
        ? `\nUWAGA: rodzaj się różni — zlecenie: ${FAMILY_LABELS[orderFamily]}`
        : "";
    return {
      className: MATCH_CLASS,
      title: `Długość zgodna z Baltic Hub (${isoLabel}).${familyNote}\n${note}`,
    };
  }
  return {
    className: ALARM_CLASS,
    alarm: true,
    title: `NIEZGODNOŚĆ: Baltic Hub podaje ${isoLabel}, a zlecenie ma „${load.container_size ?? ""}”.\n${note}`,
  };
}

function lineDecoration(load: DecoratedLoad, now: Date): CellDecoration | null {
  const agreement = compareShippingLine(load.bhub_shipping_line, load.shipping_line);
  if (agreement === "unknown") return null;

  const note = checkedAtNote(load, now);
  if (agreement === "match") {
    return { className: MATCH_CLASS, title: `Gestia zgodna z Baltic Hub (${load.bhub_shipping_line}).\n${note}` };
  }
  return {
    className: ALARM_CLASS,
    alarm: true,
    title: `NIEZGODNOŚĆ: Baltic Hub podaje armatora „${load.bhub_shipping_line}”, a zlecenie ma „${load.shipping_line ?? ""}”.\n${note}`,
  };
}

/** Znak ostrzegawczy dopisywany przed wartością w komórce z alarmem. */
export const ALARM_PREFIX = "⚠ ";

export function isAlarm(decoration: CellDecoration | null): boolean {
  return decoration?.alarm === true;
}
