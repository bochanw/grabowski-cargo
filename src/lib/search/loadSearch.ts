import type { Load } from "../../types/load";

// Wyszukiwarka dynamiczna po WSZYSTKIM (właściciel: "od terminala, kierowcy, kontenera, klienta").
// Filtr w pamięci nad danymi z TanStack Query — świadoma decyzja z CLAUDE.md dla małego zbioru
// (kilkaset zleceń); gdy urośnie do skali, której to nie udźwignie, przejście na pg_trgm po stronie
// bazy. Zapytanie dzielone na słowa, KAŻDE słowo musi wystąpić gdzieś w rekordzie (kolejność
// dowolna: "boichenko gct" trafia to samo co "gct boichenko"). Bez wielkości liter i polskich znaków.

const PL_MAP: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z",
};

export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => PL_MAP[ch] ?? ch)
    .replace(/\s+/g, " ")
    .trim();
}

// Wszystkie pola tekstowe/liczbowe rekordu + nazwa kontrahenta (id samo w sobie nic nie mówi).
export function loadSearchText(load: Load, contractorName?: string): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(load)) {
    if (key === "id" || key === "contractor_id" || key === "created_at" || key === "updated_at") continue;
    if (value === null || value === undefined || value === "") continue;
    parts.push(String(value));
  }
  if (contractorName) parts.push(contractorName);
  // Tablice bez spacji/myślników, żeby "GPULY42" trafiało "GPU LY42" i odwrotnie.
  for (const plate of [load.vehicle_plate, load.trailer_plate]) {
    if (plate) parts.push(plate.replace(/[\s-]/g, ""));
  }
  return normalizeSearchText(parts.join(" | "));
}

export function matchesQuery(searchText: string, query: string): boolean {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const compact = searchText.replace(/[\s-]/g, "");
  return tokens.every((token) => searchText.includes(token) || compact.includes(token.replace(/[\s-]/g, "")));
}
