// Kontrole na karcie kontenera z terminala — zgłoszenia właściciela:
//
//   1. „Time Out" ma być PUSTY. Niepusty znaczy, że kontener opuścił już terminal, więc plan
//      podjęcia jest nieaktualny → trójkącik przy numerze kontenera.
//   2. „Commodity Weight" (waga zgłoszona do Urzędu Celnego) ma równać się „Cargo Weight" (waga
//      towaru). Różnica to sprawa na odprawę → trójkącik przy numerze kontenera.
//   3. „Wagi, gestie, wielkości NADPISUJEMY ale musimy alarmować że się nie pokrywają ze
//      zleceniem" — wartość terminala wchodzi do kolumny, a to, co mówiło zlecenie, zostaje
//      w `terminal_conflicts` (migracja 0032) i to ono zapala trójkącik.
//
// Osobny plik od `cellDecoration.ts`, bo to są reguły o DANYCH (dają się sprawdzić jedną tabelką
// wejść i wyjść), a tamten mówi już o klasach CSS i dymkach.

import type { Load } from "@/types/load";
import { parseWeightKg } from "@/lib/containers/tare";

/** Ile kilogramów różnicy jeszcze nie jest różnicą. Terminal podaje wagi z jednym miejscem po
 *  przecinku („23976.0"), dokumenty bywają zaokrąglone do pełnych kilogramów. */
export const WEIGHT_TOLERANCE_KG = 1;

export type WeightAgreement = "unknown" | "match" | "mismatch";

export interface BhubWarning {
  /** Krótko, do dymka przy numerze kontenera. */
  text: string;
}

type CheckedLoad = Pick<
  Load,
  | "bhub_time_out"
  | "bhub_net_weight_kg"
  | "bhub_commodity_weight_kg"
  | "bhub_gross_weight_kg"
  | "net_weight_kg"
  | "gross_weight"
  | "terminal_conflicts"
>;

/**
 * Kolumny, które terminal NADPISUJE (właściciel: „Wagi, gestie, wielkości nadpisujemy ale musimy
 * alarmować że się nie pokrywają ze zleceniem"). Wartość, którą miało zlecenie PRZED nadpisaniem,
 * siedzi w `terminal_conflicts` (migracja 0032) — i to ona jest jedynym śladem rozbieżności,
 * bo w samej kolumnie stoi już liczba terminala.
 */
export const NADPISYWANE_KOLUMNY = ["gross_weight", "net_weight_kg", "container_size", "shipping_line"] as const;
export type NadpisywanaKolumna = (typeof NADPISYWANE_KOLUMNY)[number];

export function jestNadpisywana(key: string): key is NadpisywanaKolumna {
  return (NADPISYWANE_KOLUMNY as readonly string[]).includes(key);
}

/** Co mówiło ZLECENIE, zanim terminal nadpisał tę kolumnę. `null` = nie było rozbieżności. */
export function wartoscZeZlecenia(load: Pick<Load, "terminal_conflicts">, key: string): string | null {
  const konflikty = load.terminal_conflicts;
  if (!konflikty || typeof konflikty !== "object") return null;
  const wartosc = (konflikty as Record<string, unknown>)[key];
  if (wartosc === null || wartosc === undefined) return null;
  const tekst = String(wartosc).trim();
  return tekst === "" ? null : tekst;
}

/**
 * Konflikty bez kolumny, którą właśnie poprawia CZŁOWIEK — ręczna poprawka jest świadomym
 * „widziałem, tak ma być", więc gasi alarm. To jedyne miejsce, które kasuje wpisy: gdyby robił to
 * także terminal, alarm znikałby po kwadransie, zanim ktokolwiek zdążyłby go zobaczyć.
 */
export function bezKonfliktu(
  load: Pick<Load, "terminal_conflicts">,
  keys: readonly string[]
): Record<string, unknown> {
  const konflikty = { ...((load.terminal_conflicts ?? {}) as Record<string, unknown>) };
  for (const key of keys) delete konflikty[key];
  return konflikty;
}

/** Czy dwie wagi to ta sama waga. `null` po którejkolwiek stronie = „nie wiem", nigdy „różne". */
export function compareWeights(a: number | null | undefined, b: number | null | undefined): WeightAgreement {
  if (a === null || a === undefined || b === null || b === undefined) return "unknown";
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "unknown";
  return Math.abs(a - b) <= WEIGHT_TOLERANCE_KG ? "match" : "mismatch";
}

export function formatKg(kg: number): string {
  const zaokraglone = Math.round(kg * 100) / 100;
  return `${zaokraglone.toLocaleString("pl-PL")} kg`;
}

/**
 * Waga brutto, na której NAPRAWDĘ się pracuje: terminal, a gdy go nie ma — liczba ze zlecenia.
 *
 * Zlecenie trzyma to, co napisał spedytor („według armatora" też), i tego nie nadpisujemy — więc
 * każde miejsce, które liczy albo pokazuje „wagę brutto", musi pytać tutaj, zamiast czytać samo
 * pole. Inaczej „waga z terminala jest nadrzędna" obowiązywałoby tylko w jednej połowie appki.
 */
export function effectiveGrossWeightKg(
  load: Pick<Load, "bhub_gross_weight_kg" | "gross_weight">
): number | null {
  if (typeof load.bhub_gross_weight_kg === "number" && Number.isFinite(load.bhub_gross_weight_kg)) {
    return load.bhub_gross_weight_kg;
  }
  return load.gross_weight ? parseWeightKg(load.gross_weight) : null;
}

/**
 * Ostrzeżenia, które trafiają PRZY NUMER KONTENERA — czyli te o samym kontenerze, nie o polu
 * zlecenia. Pusta lista = terminal nie ma nic do zgłoszenia (albo jeszcze nie sprawdzaliśmy).
 */
export function containerWarnings(load: CheckedLoad): BhubWarning[] {
  const out: BhubWarning[] = [];

  // Pusty tekst = rubryka jest i jest pusta (kontener stoi) — to stan poprawny. `null` znaczy
  // „nie odczytałem" i milczymy: ostrzeżenie z braku wiedzy byłoby fałszywym alarmem.
  const timeOut = (load.bhub_time_out ?? "").trim();
  if (timeOut) {
    out.push({ text: `Baltic Hub: „Time Out" nie jest pusty (${timeOut}) — kontener opuścił już terminal.` });
  }

  const wagi = compareWeights(load.bhub_commodity_weight_kg, load.bhub_net_weight_kg);
  if (wagi === "mismatch") {
    out.push({
      text:
        `Baltic Hub: waga celna (Commodity ${formatKg(load.bhub_commodity_weight_kg as number)}) różni się od wagi ` +
        `towaru (Cargo ${formatKg(load.bhub_net_weight_kg as number)}).`,
    });
  }

  return out;
}

/**
 * Porównanie wagi z terminala z tą ze zlecenia — dla kolumny „Waga brutto" i „Waga netto".
 * Zwraca też liczby do dymka, żeby `cellDecoration` nie musiał ich wyłuskiwać drugi raz.
 */
export function weightAgreement(
  load: CheckedLoad,
  kolumna: "gross_weight" | "net_weight_kg"
): { agreement: WeightAgreement; terminal: number | null; zlecenie: number | null } {
  const terminal = kolumna === "gross_weight" ? load.bhub_gross_weight_kg ?? null : load.bhub_net_weight_kg ?? null;
  const zlecenie =
    kolumna === "gross_weight"
      ? load.gross_weight
        ? parseWeightKg(load.gross_weight)
        : null
      : load.net_weight_kg ?? null;
  return { agreement: compareWeights(terminal, zlecenie), terminal, zlecenie };
}
