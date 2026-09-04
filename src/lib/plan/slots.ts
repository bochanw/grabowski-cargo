// Miejsca na zestawie w Planie wspaniałym.
//
// Reguła właściciela: "90% naszej pracy polega na łączeniu transportu dwóch kontenerów
// 20-stopowych. Gdyby jednak wynikało że kontener jest 40/45 stóp, to a) nie można go zabrać
// solówką, b) scalamy obie kolumny dla tego wiersza, żeby widocznie oznaczyć, że nie możemy
// wstawić drugiego kontenera."
//
// Stąd dwa miejsca, a nie lista pozycji: 'tyl' (tył naczepy / przyczepa) i 'przod' (przód naczepy
// / solówka). Kontener zajmujący cały zestaw NIE dostaje trzeciej wartości — o tym, czy zajmuje
// jedno miejsce czy oba, decyduje `container_size`, czyli ta sama dana, którą widzi Zestawienie.
// Trzecia wartość w bazie byłaby drugą wersją tej samej prawdy i rozjechałaby się przy pierwszej
// edycji wielkości w tabeli.

import { containerSizeFamily } from "@/lib/containers/tare";
import type { Load } from "@/types/load";

export const PLAN_SLOTS = ["tyl", "przod"] as const;
export type PlanSlot = (typeof PLAN_SLOTS)[number];

export const PLAN_SLOT_LABELS: Record<PlanSlot, string> = {
  tyl: "Tył naczepy / przyczepa",
  przod: "Przód naczepy / solówka",
};

export const PLAN_SLOT_SHORT: Record<PlanSlot, string> = {
  tyl: "tył",
  przod: "przód",
};

export function isPlanSlot(value: unknown): value is PlanSlot {
  return value === "tyl" || value === "przod";
}

/**
 * Czy kontener zajmuje cały zestaw (40/45 stóp).
 *
 * NIEZNANA wielkość = false, świadomie: brak wpisu w "Wielkość" jest w danych klienta częsty
 * (patrz zlecenia bez tego pola), a zablokowanie wtedy drugiego miejsca odbierałoby dyspozytorowi
 * połowę zestawu przy każdym niedoczytanym dokumencie. Wątpliwość rozstrzyga człowiek — appka
 * pokazuje wtedy kafelek na jednym miejscu i nic nie blokuje.
 */
export function occupiesWholeSet(containerSize: string | null | undefined): boolean {
  const family = containerSizeFamily(containerSize);
  return family === "40" || family === "40HC" || family === "45";
}

export function loadOccupiesWholeSet(load: Pick<Load, "container_size">): boolean {
  return occupiesWholeSet(load.container_size);
}

/**
 * Miejsce, na którym zlecenie ma zostać ZAPISANE. Kontener zajmujący cały zestaw zapisujemy zawsze
 * jako 'tyl' — inaczej ten sam stan ("stoi na całym zestawie") miałby dwa zapisy w bazie i kafelek
 * scalony z jednego wiersza raz zaczynałby się w pierwszej, raz w drugiej kolumnie.
 */
export function normalizePlanSlot(containerSize: string | null | undefined, slot: PlanSlot): PlanSlot {
  return occupiesWholeSet(containerSize) ? "tyl" : slot;
}

/** Typ pojazdu z Panelu floty: solówka nie ma naczepy, więc nie weźmie 40/45. */
export function isSolowka(vehicleType: string | null | undefined): boolean {
  return (vehicleType ?? "").trim().toLowerCase() === "solowka";
}

/**
 * Czy wolno postawić to zlecenie na tym pojeździe. Zwraca powód odmowy albo null.
 * Reguła (a) właściciela: kontenera 40/45 nie można zabrać solówką.
 */
export function refusalReason(
  containerSize: string | null | undefined,
  vehicleType: string | null | undefined
): string | null {
  if (isSolowka(vehicleType) && occupiesWholeSet(containerSize)) {
    return `Kontener ${containerSize ?? "40/45"} nie zmieści się na solówce — potrzebny zestaw z naczepą.`;
  }
  return null;
}
