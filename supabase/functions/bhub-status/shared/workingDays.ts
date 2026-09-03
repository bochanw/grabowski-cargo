// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/lib/dates/workingDays.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

// Poprzedni dzień roboczy — domyślna "Data" zlecenia w Zestawieniu (właściciel: "docelowo będzie to
// poprzedni dzień roboczy poprzedzający rozładunek/załadunek"). Dyspozytor planuje podjęcie
// kontenera dzień roboczy PRZED terminem rozładunku/załadunku z dokumentu. Wartość to tylko
// domyślna propozycja — dyspozytor może ją zmienić przed zapisem i później przez "Edytuj".
//
// "Dzień roboczy" = poniedziałek-piątek z pominięciem polskich dni ustawowo wolnych od pracy.
// Wszystko liczone na datach kalendarzowych (UTC), bez godzin — omija problemy ze zmianą czasu.

function toUtcDate(iso: string): Date | null {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Niedziela Wielkanocna (algorytm Meeusa/Jonesa/Butchera, kalendarz gregoriański).
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

const holidayCache = new Map<number, Set<string>>();

// Dni ustawowo wolne w Polsce. Stałe + ruchome od Wielkanocy (Poniedziałek Wielkanocny, Boże
// Ciało). Wigilia (24.12) jest dniem wolnym od 2025 r. Niedziele (Wielkanoc, Zesłanie Ducha Św.)
// i tak odpadają jako weekend.
function polishHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const fixed = ["01-01", "01-06", "05-01", "05-03", "08-15", "11-01", "11-11", "12-24", "12-25", "12-26"];
  const set = new Set(fixed.map((md) => `${year}-${md}`));
  const easter = easterSunday(year);
  set.add(toIso(addDays(easter, 1))); // Poniedziałek Wielkanocny
  set.add(toIso(addDays(easter, 60))); // Boże Ciało
  holidayCache.set(year, set);
  return set;
}

export function isWorkingDay(iso: string): boolean {
  const date = toUtcDate(iso);
  if (!date) return false;
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !polishHolidays(date.getUTCFullYear()).has(iso);
}

/** Najbliższy dzień roboczy PRZED podaną datą (nigdy ta sama data). Pusty string dla złej daty. */
export function previousWorkingDay(iso: string): string {
  let date = toUtcDate(iso);
  if (!date) return "";
  do {
    date = addDays(date, -1);
  } while (!isWorkingDay(toIso(date)));
  return toIso(date);
}
