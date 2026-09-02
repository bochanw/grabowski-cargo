// Miejsce podjęcia kontenera. Właściciel na starcie: "jest możliwe tylko jedno z 3" (terminale
// GCT, BCT, BHub) — po pierwszym zleceniu EKSPORTOWYM doszły dwie sytuacje, w których kontenera
// nie podejmuje się z terminala: "poimport" (jedziemy kontenerem z wcześniejszego importu) i
// "z depotu". Dokument eksportowy zwykle wpisuje to wprost w rubryce "MIEJSCE PODJĘCIA KONTENERA",
// więc to nadal JEDNO pole, tylko z dłuższą listą wartości.
//
// Kolumna `pickup_type` w bazie jest zwykłym textem bez CHECK (patrz migracja 0001) — formularz
// pokazuje też wartość spoza listy, jeśli rekord już taką ma, zamiast ją gubić.
export const PICKUP_LOCATIONS = ["GCT", "BCT", "BHub", "Poimport", "Depot"] as const;

// Warianty zapisu spotykane w dokumentach; porównanie idzie na tekście bez spacji, myślników i
// wielkości liter ("Baltic Hub" -> "baltichub"). Kolejność ma znaczenie tylko o tyle, że pierwszy
// trafiony wariant wygrywa — wzorce są rozłączne.
const PATTERNS: { code: (typeof PICKUP_LOCATIONS)[number]; match: string[] }[] = [
  { code: "Poimport", match: ["poimport", "poimporcie", "zimportu"] },
  { code: "Depot", match: ["depot", "depo"] },
  { code: "BHub", match: ["bhub", "baltichub"] },
  { code: "GCT", match: ["gct"] },
  { code: "BCT", match: ["bct"] },
];

export function matchPickupLocation(raw: string): string {
  const text = raw.toLowerCase().replace(/[\s-]/g, "");
  if (!text) return "";
  for (const { code, match } of PATTERNS) {
    if (match.some((needle) => text.includes(needle))) return code;
  }
  return "";
}
