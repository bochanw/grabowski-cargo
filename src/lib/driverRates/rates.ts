// Stawka dla kierowcy z cennika właściciela (tabela `driver_rates`, migracja 0030): kod pocztowy
// miejsca dostawy/załadunku + tonaż → kwota.
//
// Reguły ustalone z właścicielem:
//  - kod pocztowy DOSTAWY (import) albo ZAŁADUNKU (eksport/krajówka) — w obu przypadkach to ten sam
//    adres zlecenia, więc kierunek nie ma tu znaczenia i celowo go nie sprawdzamy;
//  - o progu decyduje waga Z TERMINALA (Baltic Hub), gdy jest — a gdy jej nie ma, waga z dokumentu;
//  - zlecenie z kilkoma miejscami: liczy się NAJWYŻSZA stawka ze wszystkich miejsc.
//
// Czego appka NIE robi: nie zgaduje. Kod spoza cennika (np. 08-6xx — arkusz ma 08-1…08-5 i nie ma
// wiersza ogólnego "08") zostawia zlecenie bez stawki i z powodem wypisanym wprost. Zgadnięcie
// sąsiedniego wiersza byłoby kwotą do wypłaty wziętą z sufitu.

import { computeGrossWeightKg, parseWeightKg } from "@/lib/containers/tare";
import { normalizeSearchText } from "@/lib/search/loadSearch";
import { normalizeStops, type LoadStop } from "@/types/loadStop";
import type { Load } from "@/types/load";

export interface DriverRateRow {
  /** Same cyfry: "06" (całe 06-xxx) albo "061" (06-1xx). */
  prefix: string;
  city: string | null;
  rate_to_15t: number;
  rate_over_15t: number;
  rate_over_22t: number;
}

/** Trzy kolumny stawek z arkusza. Granice: "do 15t" obejmuje równe 15 t, "pow. 22t" to > 22 t. */
export type TonnageBracket = "do15" | "pow15" | "pow22";

export const BRACKET_LABELS: Record<TonnageBracket, string> = {
  do15: "do 15 t",
  pow15: "pow. 15 t",
  pow22: "pow. 22 t",
};

export function tonnageBracket(weightKg: number): TonnageBracket {
  if (weightKg > 22000) return "pow22";
  if (weightKg > 15000) return "pow15";
  return "do15";
}

export function rateForBracket(row: DriverRateRow, bracket: TonnageBracket): number {
  return bracket === "pow22" ? row.rate_over_22t : bracket === "pow15" ? row.rate_over_15t : row.rate_to_15t;
}

/** "061" → "06-1", "06" → "06" — zapis z arkusza, żeby cennik w appce wyglądał jak u właściciela. */
export function formatRatePrefix(prefix: string): string {
  return prefix.length === 3 ? `${prefix.slice(0, 2)}-${prefix.slice(2)}` : prefix;
}

/**
 * Kod pocztowy z dowolnego tekstu → same cyfry ("80-299", "PL 80299", "ul. Kwiatowa 3, 80-299
 * Gdańsk" → "80299"). Zwraca null, gdy w tekście nie ma polskiego kodu.
 *
 * Wymagany PEŁNY kształt NN-NNN (albo 5 cyfr pod rząd): sam prefiks „80" wyciągnięty z pierwszej
 * lepszej liczby w adresie ("Sygnały 62") wskazywałby przypadkowy wiersz cennika.
 */
export function extractPostalCode(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const dashed = text.match(/(?<![0-9])([0-9]{2})-([0-9]{3})(?![0-9])/);
  if (dashed) return dashed[1] + dashed[2];
  const plain = text.match(/(?<![0-9])([0-9]{5})(?![0-9])/);
  return plain ? plain[1] : null;
}

/** Kod pocztowy do pokazania człowiekowi: "80299" → "80-299". */
export function formatPostalCode(digits: string | null | undefined): string {
  const value = (digits ?? "").replace(/\D/g, "");
  return value.length === 5 ? `${value.slice(0, 2)}-${value.slice(2)}` : (digits ?? "");
}

/**
 * Wiersz cennika dla kodu pocztowego: najpierw 3 cyfry ("06-1"), potem 2 ("06").
 * Bardziej szczegółowy wygrywa — arkusz ma prefiksy, przy których stoi jedno i drugie
 * (06, 07, 18, 42, 56, 67), i to jest dokładnie ta sytuacja.
 */
export function findRateRow(rows: DriverRateRow[], postalDigits: string | null | undefined): DriverRateRow | null {
  const digits = (postalDigits ?? "").replace(/\D/g, "");
  if (digits.length < 2) return null;
  return (
    rows.find((row) => row.prefix.length === 3 && row.prefix === digits.slice(0, 3)) ??
    rows.find((row) => row.prefix.length === 2 && row.prefix === digits.slice(0, 2)) ??
    null
  );
}

/**
 * Ostatnia deska ratunku, gdy zlecenie nie ma kodu pocztowego: nazwa miejscowości.
 *
 * Kolumna „Miejscowość" w arkuszu jest opisem prefiksu, nie adresem — bywa zbiorcza ("Mława/
 * Przasnysz", "Okolice Warszawy"), a jedno miasto potrafi zająć kilka wierszy (Warszawa: 00-04).
 * Dlatego dopasowanie po nazwie liczy się TYLKO wtedy, gdy wszystkie trafione wiersze mają
 * identyczne stawki — inaczej nie wiadomo, o który chodzi, a zgadywanie kończy się złą wypłatą.
 */
export function findRateRowsByCity(rows: DriverRateRow[], city: string | null | undefined): DriverRateRow[] {
  const needle = normalizeSearchText(city ?? "");
  if (needle.length < 3) return [];
  return rows.filter((row) =>
    (row.city ?? "")
      .split(/[\/,]/)
      .some((part) => normalizeSearchText(part) === needle)
  );
}

function sameRates(rows: DriverRateRow[]): boolean {
  return rows.every(
    (row) =>
      row.rate_to_15t === rows[0].rate_to_15t &&
      row.rate_over_15t === rows[0].rate_over_15t &&
      row.rate_over_22t === rows[0].rate_over_22t
  );
}

/** Skąd appka wzięła wiersz cennika — pokazywane przy stawce, bo pewność każdego z nich jest inna. */
export type RateMatchSource = "kod" | "adres" | "miejscowosc";

export const RATE_SOURCE_LABELS: Record<RateMatchSource, string> = {
  kod: "kod pocztowy",
  adres: "kod pocztowy z adresu",
  miejscowosc: "nazwa miejscowości",
};

export interface RatePlace {
  /** Do komunikatu: "Radom" / "2. miejsce: Warszawa". */
  label: string;
  postal_code?: string | null;
  address?: string | null;
  city?: string | null;
}

export interface PlaceRateMatch {
  place: RatePlace;
  row: DriverRateRow;
  source: RateMatchSource;
  amount: number;
}

function matchPlace(rows: DriverRateRow[], place: RatePlace, bracket: TonnageBracket): PlaceRateMatch | null {
  // Pole "kod pocztowy" bywa wpisane niepełnie ("80-2" po ręcznej poprawce) — wtedy pełny kształt
  // NN-NNN się nie znajdzie, ale same cyfry wystarczą do dopasowania prefiksu.
  const fromField = extractPostalCode(place.postal_code) ?? (place.postal_code ?? "").replace(/\D/g, "");
  const byCode = findRateRow(rows, fromField);
  if (byCode) return { place, row: byCode, source: "kod", amount: rateForBracket(byCode, bracket) };

  // Kod bywa wpisany w środku adresu ("Słoneczna 42A, 05-500 Piaseczno") — dokumenty często nie
  // mają osobnej rubryki, a dyspozytor przepisuje adres jednym ciągiem.
  const fromAddress = extractPostalCode([place.address, place.city].filter(Boolean).join(" "));
  const byAddress = findRateRow(rows, fromAddress);
  if (byAddress) return { place, row: byAddress, source: "adres", amount: rateForBracket(byAddress, bracket) };

  const byCity = findRateRowsByCity(rows, place.city);
  if (byCity.length > 0 && sameRates(byCity)) {
    return { place, row: byCity[0], source: "miejscowosc", amount: rateForBracket(byCity[0], bracket) };
  }
  return null;
}

export interface WeightForRate {
  kg: number | null;
  /** Skąd wzięta — do komunikatu przy stawce. */
  source: "terminal" | "brutto" | "towar+tara" | "towar";
}

/**
 * Waga, po której liczy się próg. Decyzja właściciela: waga z terminala (Baltic Hub) jest
 * nadrzędna, a gdy jej nie ma — waga z dokumentu.
 *
 * Kolejność: waga zważona w terminalu → liczbowa waga brutto zlecenia (tam też ląduje waga
 * z terminala, gdy przyszła wcześniej) → towar + tara wg typu kontenera → sama waga towaru.
 * Ostatni krok zaniża wagę o tarę (2,2-4,8 t), więc jest sygnalizowany w ostrzeżeniach:
 * przy ładunku bliskim progu potrafi wskazać niższą stawkę.
 */
export function weightForRate(input: {
  bhub_gross_weight_kg?: number | null;
  gross_weight?: string | null;
  net_weight_kg?: number | null;
  container_size?: string | null;
}): WeightForRate {
  if (typeof input.bhub_gross_weight_kg === "number" && Number.isFinite(input.bhub_gross_weight_kg)) {
    return { kg: input.bhub_gross_weight_kg, source: "terminal" };
  }
  const gross = (input.gross_weight ?? "").trim();
  // Tylko czysto liczbowe brutto — "według armatora" nie jest wagą.
  if (/^\d+([.,]\d+)?(\s*kg)?$/i.test(gross)) {
    const kg = parseWeightKg(gross);
    if (kg !== null) return { kg, source: "brutto" };
  }
  const computed = computeGrossWeightKg(input.net_weight_kg ?? null, input.container_size ?? null);
  if (computed !== null) return { kg: computed, source: "towar+tara" };
  if (typeof input.net_weight_kg === "number" && Number.isFinite(input.net_weight_kg)) {
    return { kg: input.net_weight_kg, source: "towar" };
  }
  return { kg: null, source: "towar" };
}

export interface DriverRateInput {
  postal_code?: string | null;
  address?: string | null;
  city?: string | null;
  stops?: unknown;
  bhub_gross_weight_kg?: number | null;
  gross_weight?: string | null;
  net_weight_kg?: number | null;
  container_size?: string | null;
}

export interface DriverRateSuggestion {
  amount: number;
  /** Prefiks cennika w zapisie z arkusza ("06-1") — trafia do `loads.driver_rate_code`. */
  code: string;
  bracket: TonnageBracket;
  weightKg: number;
  weightSource: WeightForRate["source"];
  matchSource: RateMatchSource;
  /** Miejsce, które dało tę (najwyższą) stawkę. */
  placeLabel: string;
  /** Jedno zdanie do dymka i do zestawienia: skąd ta kwota. */
  explanation: string;
  /** Co warto sprawdzić ręcznie (waga bez tary, miejsce bez stawki, dopasowanie po nazwie miasta). */
  warnings: string[];
}

export interface DriverRateResult {
  suggestion: DriverRateSuggestion | null;
  /** Dlaczego nie ma stawki — pokazywane wprost, żeby brak kwoty nie był ciszą. */
  reason: string | null;
  warnings: string[];
}

/** Miejsca zlecenia w kolejności: główne (kolumny `city`/`address`), potem kolejne z `stops`. */
export function ratePlaces(input: DriverRateInput): RatePlace[] {
  const stops: LoadStop[] = normalizeStops(input.stops);
  const main: RatePlace = {
    label: input.city?.trim() || input.address?.trim() || "miejsce zlecenia",
    postal_code: input.postal_code ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
  };
  return [
    main,
    ...stops.map((stop, index) => ({
      label: `${index + 2}. miejsce: ${stop.city || stop.address || "(bez adresu)"}`,
      // Kolejne miejsca mają własny kod pocztowy (src/types/loadStop.ts); starsze wpisy w jsonb go
      // nie mają, więc i tu ratuje kod wyłuskany z adresu.
      postal_code: stop.postal_code || null,
      address: stop.address,
      city: stop.city,
    })),
  ];
}

/**
 * Stawka dla kierowcy dla jednego zlecenia. Zlecenie wielopunktowe: bierzemy NAJWYŻSZĄ stawkę ze
 * wszystkich miejsc (decyzja właściciela — kierowca jedzie najdalej), a w wyjaśnieniu piszemy,
 * które miejsce ją dało.
 */
export function computeDriverRate(input: DriverRateInput, rows: DriverRateRow[]): DriverRateResult {
  const warnings: string[] = [];
  if (rows.length === 0) return { suggestion: null, reason: "Cennik stawek jest pusty.", warnings };

  const weight = weightForRate(input);
  if (weight.kg === null) {
    return {
      suggestion: null,
      reason: "Brak wagi — bez niej nie wiadomo, który próg tonażu obowiązuje (do 15 t / pow. 15 t / pow. 22 t).",
      warnings,
    };
  }
  if (weight.source === "towar") {
    warnings.push(
      "Waga bez tary kontenera (nieznany typ kontenera) — przy ładunku blisko progu stawka może być zaniżona."
    );
  }

  const bracket = tonnageBracket(weight.kg);
  const places = ratePlaces(input);
  const matches = places
    .map((place) => matchPlace(rows, place, bracket))
    .filter((match): match is PlaceRateMatch => match !== null);

  if (matches.length === 0) {
    const kody = places
      .map((place) => extractPostalCode(place.postal_code) ?? extractPostalCode([place.address, place.city].filter(Boolean).join(" ")))
      .filter((code): code is string => code !== null)
      .map(formatPostalCode);
    return {
      suggestion: null,
      reason: kody.length
        ? `Cennik nie ma stawki dla kodu ${kody.join(", ")} — uzupełnij go w zakładce „Stawki kierowców".`
        : "Brak kodu pocztowego dostawy/załadunku — bez niego nie da się odczytać stawki z cennika.",
      warnings,
    };
  }

  const nieznalezione = places.length - matches.length;
  if (nieznalezione > 0) {
    warnings.push(
      `${nieznalezione} z ${places.length} miejsc nie ma stawki w cenniku — kwota liczona z pozostałych.`
    );
  }

  // Najwyższa stawka; przy remisie wygrywa miejsce wcześniejsze (główne przed kolejnymi).
  const best = matches.reduce((a, b) => (b.amount > a.amount ? b : a));
  if (best.source === "miejscowosc") {
    warnings.push(
      `Stawka dopasowana po nazwie miejscowości („${best.row.city}"), bo zlecenie nie ma kodu pocztowego — wpisz kod, żeby mieć pewność.`
    );
  }

  const skad = matches.length > 1 ? `najwyższa z ${matches.length} miejsc (${best.place.label}), ` : "";
  return {
    suggestion: {
      amount: best.amount,
      code: formatRatePrefix(best.row.prefix),
      bracket,
      weightKg: weight.kg,
      weightSource: weight.source,
      matchSource: best.source,
      placeLabel: best.place.label,
      explanation:
        `${skad}cennik ${formatRatePrefix(best.row.prefix)}` +
        `${best.row.city ? ` (${best.row.city})` : ""}, ${BRACKET_LABELS[bracket]} — waga ${Math.round(weight.kg)} kg` +
        ` (${WEIGHT_SOURCE_LABELS[weight.source]}), dopasowanie po: ${RATE_SOURCE_LABELS[best.source]}.`,
      warnings,
    },
    reason: null,
    warnings,
  };
}

export const WEIGHT_SOURCE_LABELS: Record<WeightForRate["source"], string> = {
  terminal: "waga z terminala",
  brutto: "waga brutto zlecenia",
  "towar+tara": "towar + tara kontenera",
  towar: "waga towaru, bez tary",
};

/** Zapisane zlecenie → wejście do wyliczenia stawki (te same pola, inny kształt). */
export function loadRateInput(load: Load): DriverRateInput {
  return {
    postal_code: load.postal_code,
    address: load.address,
    city: load.city,
    stops: load.stops,
    bhub_gross_weight_kg: load.bhub_gross_weight_kg,
    gross_weight: load.gross_weight,
    net_weight_kg: load.net_weight_kg,
    container_size: load.container_size,
  };
}
