// Kierunek zlecenia — JEDNO miejsce na całą wiedzę o tym, czym są import, eksport i krajówka.
//
// Krajówka (właściciel: "trzeci typ zlecenia — krajówka, zaliczamy do exportów ale są one zawsze
// nadrzędne (nad nimi) w zestawieniu, w planie wspaniałym też to będzie podpięte pod export") jest
// osobną wartością `direction` w bazie (migracja 0026), a nie flagą przy eksporcie: w Zestawieniu
// ma własny blok, który stoi NAD eksportem.
//
// Zarazem wszędzie, gdzie liczy się STRONA ZESTAWU — kolumny Planu wspaniałego, etykiety
// "załadunek" zamiast "rozładunek", trasa na fakturze — krajówka zachowuje się jak eksport. Ta
// reguła siedzi WYŁĄCZNIE w `isExportSide()`: gdyby rozejść się po kilkunastu porównaniach
// `direction === "E"`, pierwsze przeoczone wysłałoby krajówkę do kolumn importu albo dało jej
// etykiety rozładunku. Stąd zakaz porównywania `=== "E"` poza tym plikiem.

import type { Direction } from "@/types/load";

/**
 * Kolejność bloków w Zestawieniu: krajówka NAD eksportem, import na końcu.
 * (właściciel: krajówki "są zawsze nadrzędne (nad nimi)").
 */
export const DIRECTION_ORDER: Direction[] = ["K", "E", "I"];

export const DIRECTION_LABELS: Record<Direction, string> = {
  K: "Krajówka",
  E: "Eksport",
  I: "Import",
};

/** Skrót na kafelki i plakietki, gdzie nie ma miejsca na pełne słowo. */
export const DIRECTION_SHORT: Record<Direction, string> = {
  K: "KRAJ",
  E: "EKS",
  I: "IMP",
};

/** Opcje list rozwijanych — ta sama treść w formularzu importu i w edycji inline w tabeli. */
export const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: "I", label: "Import" },
  { value: "E", label: "Eksport" },
  { value: "K", label: "Krajówka (liczy się do eksportów)" },
];

export function isDirection(value: unknown): value is Direction {
  return value === "I" || value === "E" || value === "K";
}

/**
 * Czy zlecenie stoi po stronie EKSPORTU — czyli: kolumny eksportu w Planie wspaniałym, etykiety
 * "załadunek"/"data załadunku", trasa eksportowa na fakturze. Krajówka: tak.
 */
export function isExportSide(direction: Direction | "" | null | undefined): boolean {
  return direction === "E" || direction === "K";
}

/** Krajówka — transport krajowy, bez portu po drugiej stronie. */
export function isDomestic(direction: Direction | "" | null | undefined): boolean {
  return direction === "K";
}
