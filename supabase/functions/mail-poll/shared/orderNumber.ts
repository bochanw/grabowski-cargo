// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/lib/loads/orderNumber.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

// Numer zlecenia jest u klienta UNIKALNY (właściciel wprost: "nr zlecenia jest unikalny"), ale w
// dokumentach bywa zapisany różnie: "ZD/1797/6/2026", "ZD 1797-6 2026", "zd1797/6/2026". Wszystkie
// porównania numerów idą więc na formie sprowadzonej do samych znaków alfanumerycznych, wielkimi
// literami.
//
// TA SAMA reguła stoi w trzech miejscach i musi liczyć to samo:
//   • tutaj (przeglądarka: rozpoznanie zlecenia przy wgraniu kolejnego dokumentu),
//   • `public.normalized_order_number` w SQL (migracja 0010, indeks pod dopasowanie maili),
//   • `mail-poll` (kopia tego pliku generowana przez scripts/build-edge-shared.mjs).
export function normalizeOrderNumber(value: string | null | undefined): string {
  return (value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

// Numery krótsze niż to (po normalizacji) pomijamy przy dopasowywaniu — "12/26" trafiałoby
// przypadkiem w cudze zlecenia.
export const MIN_ORDER_NUMBER_LENGTH = 5;

export function sameOrderNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeOrderNumber(a);
  const right = normalizeOrderNumber(b);
  return left.length >= MIN_ORDER_NUMBER_LENGTH && left === right;
}

/**
 * Zlecenie o tym numerze wśród już istniejących — podstawa reguły "drugi dokument do tego samego
 * zlecenia nie tworzy nowego rekordu, tylko uzupełnia brakujące pola".
 */
export function findLoadByOrderNumber<T extends { order_number: string | null }>(
  loads: T[],
  orderNumber: string | null | undefined
): T | null {
  const key = normalizeOrderNumber(orderNumber);
  if (key.length < MIN_ORDER_NUMBER_LENGTH) return null;
  return loads.find((load) => normalizeOrderNumber(load.order_number) === key) ?? null;
}
