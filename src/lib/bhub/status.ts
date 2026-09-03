// Status kontenera w Baltic Hub — pięć kodów ustalonych przez właściciela. Komórka w Zestawieniu
// pokazuje TYLKO dwie litery i kolor tła; pełne znaczenie idzie w dymku (title).
//
//   SS — stopka na statku          czerwone tło
//   ZS — zwolniony, na statku      niebieskie tło
//   SO — stopka operacyjna         żółte tło
//   SP — stopka, plac              pomarańczowe tło
//   ZP — zwolniony, na placu       szare tło
//
// "Stopka" = blokada trzymająca kontener (nie wolno go wydać), "zwolniony" = blokady zdjęte.
// Druga oś to miejsce: kontener stoi jeszcze na statku albo już na placu terminala.
//
// ZP jest stanem KOŃCOWYM: kontener zwolniony i na placu, nie ma czego dalej sprawdzać
// (właściciel: "ZP już nie ruszamy"). Patrz `isFinalStatus` i pętla w schedule.ts.

export const BHUB_STATUSES = ["SS", "ZS", "SO", "SP", "ZP"] as const;
export type BhubStatus = (typeof BHUB_STATUSES)[number];

export const BHUB_STATUS_LABELS: Record<BhubStatus, string> = {
  SS: "Stopka na statku",
  ZS: "Zwolniony, na statku",
  SO: "Stopka operacyjna",
  SP: "Stopka, plac",
  ZP: "Zwolniony, na placu",
};

// Klasy Tailwinda tła + koloru tekstu. Kolory są jawnie kontrastowe w obu motywach: kolor niesie
// tu informację, więc komórka nie może zblednąć do nieczytelności na ciemnym tle.
export const BHUB_STATUS_CLASSES: Record<BhubStatus, string> = {
  SS: "bg-red-600 text-white dark:bg-red-700",
  ZS: "bg-blue-600 text-white dark:bg-blue-700",
  SO: "bg-yellow-300 text-yellow-950 dark:bg-yellow-400 dark:text-yellow-950",
  SP: "bg-orange-400 text-orange-950 dark:bg-orange-500 dark:text-orange-950",
  ZP: "bg-zinc-300 text-zinc-800 dark:bg-zinc-600 dark:text-zinc-100",
};

export function isBhubStatus(value: unknown): value is BhubStatus {
  return typeof value === "string" && (BHUB_STATUSES as readonly string[]).includes(value);
}

/** ZP = zwolniony i na placu. Nic się już nie zmieni, więc przestajemy odpytywać. */
export function isFinalStatus(status: string | null | undefined): boolean {
  return status === "ZP";
}

/**
 * Wyprowadzenie kodu z dwóch faktów, które terminal podaje osobno: gdzie stoi kontener i czy wisi
 * na nim blokada. Świadomie NIE jest to dopasowywanie napisów ze strony — pięć kodów właściciela
 * to iloczyn dwóch osi (stopka/zwolniony × statek/plac) plus wyróżniona "stopka operacyjna",
 * więc reguła zapisana wprost jest odporna na to, jak dokładnie strona formułuje zdanie.
 *
 * PIERWSZEŃSTWO stopki operacyjnej nad miejscem jest ZAŁOŻENIEM do potwierdzenia na żywych danych:
 * właściciel wymienił SO jako osobny stan, bez rozróżnienia statek/plac, więc kontener ze stopką
 * operacyjną dostaje SO niezależnie od tego, gdzie stoi.
 */
export function deriveBhubStatus(input: {
  /** true = kontener jeszcze na statku, false = na placu, null = terminal nie podał */
  onVessel: boolean | null;
  /** blokada operacyjna (wyróżniony rodzaj stopki) */
  operationalHold?: boolean;
  /** jakakolwiek inna blokada trzymająca kontener */
  held: boolean;
}): BhubStatus | null {
  if (input.operationalHold) return "SO";
  if (input.onVessel === null) return null;
  if (input.held) return input.onVessel ? "SS" : "SP";
  return input.onVessel ? "ZS" : "ZP";
}

/**
 * Awaryjne rozpoznanie kodu z gotowego napisu — używane, gdy źródło poda status słowami zamiast
 * dwóch osobnych faktów (np. skrót wprost ze strony albo wartość wpisana ręcznie).
 *
 * Zwraca null dla wszystkiego, czego nie umiemy nazwać. To jest CELOWE: właściciel zapowiedział,
 * że znaczenie kolejnych statusów będzie tłumaczył z czasem, a zgadnięty kod pomalowałby komórkę
 * na kolor niosący nieprawdziwą informację. Nierozpoznaną wartość trzymamy jako surowy tekst
 * (kolumna `bhub_status_raw`) i pokazujemy bez koloru.
 */
export function matchBhubStatus(raw: string | null | undefined): BhubStatus | null {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) return null;
  if (isBhubStatus(value)) return value;

  const text = value.toLowerCase().replace(/[\s,.\-–—()]/g, "");
  const onVessel = /statk|statek|navessel|onvessel|wessel/.test(text);
  const onYard = /plac|nayard|onyard|skladow|składow/.test(text);
  const released = /zwolnion|released|freed/.test(text);
  const operational = /stopkaoperacyj|operacyjn|operational/.test(text);
  const held = /stopk|blokad|hold|zatrzyman/.test(text);

  if (operational) return "SO";
  if (!onVessel && !onYard) return null;
  if (released) return onVessel ? "ZS" : "ZP";
  if (held) return onVessel ? "SS" : "SP";
  return null;
}
