// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/lib/bhub/schedule.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

// Kiedy i które kontenery odpytujemy w Baltic Hub.
// Właściciel: "Odpytujemy co 15 minut w dni robocze od 6 do 18. Tylko kontenery które nie mają
// statusu ZP. ZP już nie ruszamy (jest już zwolniony i nie ma to sensu)."
//
// Godziny liczymy w czasie WARSZAWSKIM, nie UTC. To nie jest drobiazg: pg_cron i Edge Functions
// chodzą w UTC, więc okno "6-18" wyliczone z UTC byłoby latem przesunięte o dwie godziny —
// odpytywanie ruszałoby o 8:00 i kończyło o 20:00 czasu terminala.

import { isWorkingDay } from "./workingDays.ts";
import { isFinalStatus } from "./status.ts";

export const POLL_INTERVAL_MINUTES = 15;
export const POLL_START_HOUR = 6;
/** Górna granica jest wyłączna: ostatnie odpytanie startuje o 17:45, o 18:00 już nie. */
export const POLL_END_HOUR = 18;

const WARSAW = "Europe/Warsaw";

/** Data (YYYY-MM-DD) i godzina w strefie warszawskiej dla podanej chwili. */
export function warsawParts(now: Date): { iso: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: WARSAW,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // hourCycle h23 potrafi zwrócić "24" o północy — sprowadzamy do 0.
  const hour = Number(get("hour")) % 24;
  return { iso: `${get("year")}-${get("month")}-${get("day")}`, hour, minute: Number(get("minute")) };
}

/**
 * Czy teraz jest okno odpytywania: dzień roboczy (pon-pt bez polskich świąt — ta sama lista, co
 * przy liczeniu domyślnej daty zlecenia) i godzina z przedziału [6:00, 18:00).
 */
export function isWithinPollingWindow(now: Date): boolean {
  const { iso, hour } = warsawParts(now);
  if (!isWorkingDay(iso)) return false;
  return hour >= POLL_START_HOUR && hour < POLL_END_HOUR;
}

/**
 * Terminale, których stan umiemy sprawdzić. Nazwy są DOKŁADNIE tymi z listy "Podjęcie"
 * (`pickupLocations.ts`), więc o terminalu decyduje to samo pole, które dyspozytor już wypełnia.
 * "Poimport" i "Depot" to nie terminale — tam nie ma czego odpytywać.
 */
export const TERMINALE = ["BHub", "BCT", "GCT"] as const;
export type TerminalName = (typeof TERMINALE)[number];

export function isTerminalPickup(pickup: string | null | undefined): pickup is TerminalName {
  return (TERMINALE as readonly string[]).includes((pickup ?? "").trim());
}

export interface TrackableLoad {
  pickup_type: string | null;
  container_number: string | null;
  bhub_status: string | null;
}

/**
 * Czy to zlecenie w ogóle podlega śledzeniu. Trzy warunki właściciela naraz:
 * kontener podejmowany z BHub, znany numer kontenera, status inny niż ZP.
 */
export function shouldTrackLoad(load: TrackableLoad): boolean {
  if (!isTerminalPickup(load.pickup_type)) return false;
  if (!(load.container_number ?? "").trim()) return false;
  return !isFinalStatus(load.bhub_status);
}
