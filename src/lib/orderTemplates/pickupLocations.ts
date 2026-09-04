// Miejsce podjęcia kontenera. Właściciel na starcie: "jest możliwe tylko jedno z 3" (terminale
// GCT, BCT, BHub) — po pierwszym zleceniu EKSPORTOWYM doszły dwie sytuacje, w których kontenera
// nie podejmuje się z terminala: "poimport" (jedziemy kontenerem z wcześniejszego importu) i
// "z depotu". Dokument eksportowy zwykle wpisuje to wprost w rubryce "MIEJSCE PODJĘCIA KONTENERA",
// więc to nadal JEDNO pole, tylko z dłuższą listą wartości.
//
// Kolumna `pickup_type` w bazie jest zwykłym textem bez CHECK (patrz migracja 0001) — formularz
// pokazuje też wartość spoza listy, jeśli rekord już taką ma, zamiast ją gubić.
export const PICKUP_LOCATIONS = ["GCT", "BCT", "BHub", "Poimport", "Depot"] as const;

// Gdzie ZDAJEMY kontener, gdy nie ma na niego ładunku i jedzie na pusto (`loads.submitted_where`).
// Ta sama lista terminali bez "Poimport" — po stronie zdania to nie jest miejsce, tylko pochodzenie
// kontenera. Kolumna jest zwykłym textem i bywa instrukcją ("zgodnie z instrukcjami armatora"),
// więc lista jest podpowiedzią, a wartość spoza niej zostaje (patrz withCurrentOption).
export const EMPTY_DROP_LOCATIONS = ["GCT", "BCT", "BHub", "Depot"] as const;

// Warianty zapisu spotykane w dokumentach; porównanie idzie na tekście bez spacji, myślników i
// wielkości liter ("Baltic Hub" -> "baltichub"). Kolejność ma znaczenie tylko o tyle, że pierwszy
// trafiony wariant wygrywa — wzorce są rozłączne.
//
// PEŁNE NAZWY terminali są tu tak samo ważne jak skróty (zgłoszenie właściciela: "«Gdynia
// Container Terminal» to po prostu GCT"). Model czytający nieznane zlecenie przepisuje nazwę
// dosłownie z dokumentu, a bez tych wariantów wartość nie trafiała w listę rozwijaną.
const PATTERNS: { code: (typeof PICKUP_LOCATIONS)[number]; match: string[] }[] = [
  { code: "Poimport", match: ["poimport", "poimporcie", "zimportu"] },
  { code: "Depot", match: ["depot", "depo"] },
  // BHub = Baltic Hub w Gdańsku (dawniej DCT Gdańsk) — bywa pisany obiema nazwami.
  { code: "BHub", match: ["bhub", "baltichub", "dctgdansk", "dctgdańsk"] },
  { code: "GCT", match: ["gct", "gdyniacontainerterminal"] },
  // BCT = Bałtycki Terminal Kontenerowy w Gdyni (ang. Baltic Container Terminal).
  { code: "BCT", match: ["bct", "balticcontainerterminal", "baltyckiterminalkontenerowy", "bałtyckiterminalkontenerowy"] },
];

function normalizeKey(raw: string): string {
  return (raw ?? "").toLowerCase().replace(/[\s,.\-–—()]/g, "");
}

export function matchPickupLocation(raw: string): string {
  const text = normalizeKey(raw);
  if (!text) return "";
  for (const { code, match } of PATTERNS) {
    if (match.some((needle) => text.includes(needle))) return code;
  }
  return "";
}

// Nazwy terminali dopuszczalne jako CAŁA wartość pola (z opcjonalnym dopiskiem miasta) — patrz
// normalizeTerminalName. Świadomie inny zestaw niż PATTERNS: tam wystarczy fragment tekstu, tu
// wartość musi być SAMĄ nazwą terminala.
// (nazwa miasta i forma prawna są odcinane przed porównaniem, więc "GCT Gdynia" == "gct")
const TERMINAL_NAMES: { code: "GCT" | "BCT" | "BHub"; names: string[] }[] = [
  { code: "GCT", names: ["gct", "gdyniacontainerterminal"] },
  { code: "BCT", names: ["bct", "balticcontainerterminal", "baltyckiterminalkontenerowy", "bałtyckiterminalkontenerowy"] },
  { code: "BHub", names: ["bhub", "baltichub", "dct"] },
];

const TERMINAL_CITY_SUFFIX = /(gdynia|gdansk|gdańsk|sa|spzoo)+$/;

/**
 * Sprowadza do skrótu (GCT/BCT/BHub) wartość, która jest SAMĄ nazwą terminala — używane tam, gdzie
 * pole bywa i terminalem, i zwykłym adresem: "Miejsce złożenia/zdania kontenera" (właściciel: GCT
 * to "miejsce zdawania i pobierania kontenerów", więc ta sama nazwa pada po obu stronach zlecenia).
 *
 * Świadomie NIE jest to matchPickupLocation: tamta szuka fragmentu w dowolnym tekście, więc
 * "Depot Gdańsk, ul. Kontenerowa 7" zamieniłaby na samo "Depot" i skasowała adres. Tutaj wartość
 * spoza listy zwracamy BEZ ZMIAN — normalizujemy tylko wtedy, gdy nie ma czego zgubić.
 */
export function normalizeTerminalName(raw: string): string {
  const value = (raw ?? "").trim();
  const key = normalizeKey(value).replace(TERMINAL_CITY_SUFFIX, "");
  if (!key) return value;
  for (const { code, names } of TERMINAL_NAMES) {
    if (names.includes(key)) return code;
  }
  return value;
}
