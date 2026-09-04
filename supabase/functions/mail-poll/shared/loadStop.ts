// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/types/loadStop.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

// KOLEJNE miejsca załadunku/rozładunku jednego zlecenia (właściciel: "zlecenia krajowe, bądź
// w sumie jakiekolwiek, mogą mieć więcej niż jeden rozładunek/załadunek").
//
// Dlaczego lista DODATKOWYCH miejsc, a nie kompletu:
// pierwsze miejsce zostaje tam, gdzie było od pierwszej migracji — w kolumnach `company_name`,
// `address`, `city`, `secondary_date`, `time_of_day`. Trzyma je cała reszta appki: kolumny
// Zestawienia, kafelek Planu wspaniałego, trasa na fakturze, wyszukiwarka, szablony. Przepisanie
// pierwszego miejsca do listy znaczyłoby DWIE KOPIE tej samej prawdy (kolumna i element listy),
// a to w tym repo skończyło się już raz rozjazdem. Stąd reguła: `loads.stops` = miejsca 2., 3., …
//
// Dlaczego jsonb, a nie tabela `load_stops`: miejsca czyta się i zapisuje ZAWSZE razem ze
// zleceniem (formularz importu, jeden UPDATE, jeden wiersz w dzienniku zmian). Osobna tabela
// dokładałaby join do każdego widoku, własne RLS i własny kanał Realtime — bez żadnego zapytania,
// które by z tego korzystało. Kształt listy zna WYŁĄCZNIE appka (jak `user_view_settings`), więc
// dołożenie pola do miejsca nie wymaga migracji — i dlatego każdy odczyt przechodzi przez
// `normalizeStops` (w jsonb może siedzieć cokolwiek: starsza wersja appki, ręczna edycja w SQL).

export type StopKind = "" | "load" | "unload";

export interface LoadStop {
  /** "" = dokument nie mówi (albo nie ma znaczenia); appka niczego nie domyśla. */
  kind: StopKind;
  company_name: string;
  address: string;
  city: string;
  /**
   * Kod pocztowy tego miejsca — od niego zależy stawka dla kierowcy (src/lib/driverRates/rates.ts),
   * a przy zleceniu wielopunktowym liczy się NAJWYŻSZA stawka ze wszystkich miejsc, więc kod
   * kolejnego miejsca potrafi zdecydować o kwocie. Starsze wpisy w jsonb go nie mają — wtedy
   * ratuje kod wyłuskany z `address`.
   */
  postal_code: string;
  /** RRRR-MM-DD albo puste — kolejne miejsce bywa innego dnia niż pierwsze. */
  date: string;
  time: string;
  notes: string;
}

export const EMPTY_STOP: LoadStop = {
  kind: "",
  company_name: "",
  address: "",
  city: "",
  postal_code: "",
  date: "",
  time: "",
  notes: "",
};

export const STOP_KIND_LABELS: Record<StopKind, string> = {
  "": "— (nie podano)",
  load: "Załadunek",
  unload: "Rozładunek",
};

export const STOP_KINDS: StopKind[] = ["", "load", "unload"];

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** Czy w tym miejscu w ogóle cokolwiek stoi — puste wiersze formularza nie mają po co iść do bazy. */
export function isStopEmpty(stop: LoadStop): boolean {
  return !stop.company_name && !stop.address && !stop.city && !stop.postal_code && !stop.date && !stop.time && !stop.notes;
}

/**
 * Dowolna zawartość jsonb (albo odpowiedź modelu) → lista miejsc w kształcie, który zna appka.
 * Puste miejsca odpadają, żeby "2 miejsca" w tabeli znaczyło dwa PRAWDZIWE adresy.
 */
export function normalizeStops(raw: unknown): LoadStop[] {
  if (!Array.isArray(raw)) return [];
  const stops: LoadStop[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const kindRaw = textOf(source.kind).toLowerCase();
    const stop: LoadStop = {
      kind: kindRaw === "load" || kindRaw === "zaladunek" ? "load" : kindRaw === "unload" || kindRaw === "rozladunek" ? "unload" : "",
      company_name: textOf(source.company_name),
      address: textOf(source.address),
      city: textOf(source.city),
      postal_code: textOf(source.postal_code),
      date: textOf(source.date),
      time: textOf(source.time),
      notes: textOf(source.notes),
    };
    if (!isStopEmpty(stop)) stops.push(stop);
  }
  return stops;
}

/** Jedna linia opisu miejsca — używana w tabeli, na kafelku planu i w dymkach. */
export function describeStop(stop: LoadStop): string {
  const gdzie = [stop.city, stop.company_name].map((v) => v.trim()).filter(Boolean).join(", ");
  const kiedy = [stop.date, stop.time].filter(Boolean).join(" ");
  const prefix = stop.kind ? `${STOP_KIND_LABELS[stop.kind]}: ` : "";
  return [`${prefix}${gdzie || stop.address || "(bez adresu)"}`, kiedy].filter(Boolean).join(" · ");
}

/** Skrót do komórki tabeli: "Łódź; Warszawa". */
export function summarizeStops(stops: LoadStop[]): string {
  if (stops.length === 0) return "";
  return stops.map((stop) => stop.city || stop.company_name || stop.address || "?").join("; ");
}
