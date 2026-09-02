// Miejsce podjęcia kontenera — właściciel: "jest możliwe tylko jedno z 3" (terminale w Gdyni/
// Gdańsku: GCT, BCT, BHub). Parser dopasowuje kod z tekstu dokumentu (np. "GCT Gdynia" → "GCT"),
// formularz pokazuje listę rozwijaną, żeby dyspozytor mógł przestawić. Kolumna `pickup_type` w
// bazie jest zwykłym textem bez CHECK (patrz migracja 0001) — formularz edycji pokazuje też
// wartość spoza listy, jeśli rekord już taką ma (np. "poimport" z arkusza), zamiast ją gubić.
export const PICKUP_LOCATIONS = ["GCT", "BCT", "BHub"] as const;

export function matchPickupLocation(raw: string): string {
  const text = raw.toLowerCase().replace(/[\s-]/g, "");
  for (const code of PICKUP_LOCATIONS) {
    if (text.includes(code.toLowerCase())) return code;
  }
  return "";
}
