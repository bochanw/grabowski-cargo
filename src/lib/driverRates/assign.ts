// Przypisanie stawki dla kierowcy do ZAPISANEGO zlecenia — jedno miejsce na regułę „kiedy appce
// wolno przeliczyć stawkę".
//
// Reguła: wolno tylko wtedy, gdy stawki nie wpisał człowiek (`driver_rate_source = 'manual'`).
// Świadome „nie ma stawki" (dyspozytor wyczyścił pole) też jest decyzją człowieka i zostaje.
// Bez tej granicy każda edycja wagi albo dopięcie dokumentu po cichu cofałoby ręczną poprawkę,
// a to jest kwota do wypłaty.

import { computeDriverRate, loadRateInput, type DriverRateRow, type DriverRateSuggestion } from "./rates";
import type { Load } from "@/types/load";

export interface DriverRatePatch {
  driver_rate: number | null;
  driver_rate_code: string | null;
  driver_rate_source: "auto" | "manual" | null;
}

/** Czy appka może sama ruszyć stawkę tego zlecenia. */
export function canAutoAssign(load: Pick<Load, "driver_rate_source">): boolean {
  return load.driver_rate_source !== "manual";
}

export interface AutoRateResult {
  patch: DriverRatePatch | null;
  suggestion: DriverRateSuggestion | null;
  reason: string | null;
}

/**
 * Stawka dla zlecenia po zmianie (edycja komórki, dopięcie dokumentu, waga z terminala) albo przy
 * przeliczaniu zbiorczym. `patch` jest null, gdy nie ma czego zmieniać: stawka ręczna, brak cennika
 * albo wyliczona kwota jest dokładnie tą, która już stoi przy zleceniu.
 */
export function autoDriverRate(load: Load, rates: DriverRateRow[]): AutoRateResult {
  if (!canAutoAssign(load)) return { patch: null, suggestion: null, reason: "Stawka wpisana ręcznie — nie ruszamy jej." };
  const result = computeDriverRate(loadRateInput(load), rates);
  const suggestion = result.suggestion;
  if (!suggestion) return { patch: null, suggestion: null, reason: result.reason };
  if (load.driver_rate === suggestion.amount && load.driver_rate_code === suggestion.code && load.driver_rate_source === "auto") {
    return { patch: null, suggestion, reason: null };
  }
  return {
    patch: { driver_rate: suggestion.amount, driver_rate_code: suggestion.code, driver_rate_source: "auto" },
    suggestion,
    reason: null,
  };
}

/**
 * Stawka zatwierdzana z formularza zlecenia. Źródło rozstrzyga porównanie z wyliczeniem: kwota
 * równa podpowiedzi to 'auto' (wolno ją później przeliczyć), każda inna — 'manual'. Dzięki temu
 * formularz nie potrzebuje osobnego pola "czy to ja wpisałem", którego dyspozytor i tak musiałby
 * pilnować.
 */
export function driverRatePatchFromForm(
  amount: number | null,
  suggestion: DriverRateSuggestion | null
): DriverRatePatch {
  if (amount === null) {
    // Puste pole po podpowiedzi = świadome „bez stawki"; bez podpowiedzi = po prostu jej nie ma.
    return { driver_rate: null, driver_rate_code: null, driver_rate_source: suggestion ? "manual" : null };
  }
  const auto = suggestion !== null && suggestion.amount === amount;
  return {
    driver_rate: amount,
    driver_rate_code: auto ? suggestion.code : null,
    driver_rate_source: auto ? "auto" : "manual",
  };
}
