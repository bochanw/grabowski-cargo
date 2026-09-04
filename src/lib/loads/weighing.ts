// Ważenie w JEDNEJ kolumnie (właściciel: „ważenie już mamy kolumnę ważenie gdzie — to jest to
// samo"). Wcześniej stały obok siebie „czy wymagane" (boolean, migracja 0029) i „gdzie"
// (`weighing_export`, kolumna R arkusza) — a w praktyce dokument pisze tylko GDZIE się waży, i to
// samo w sobie znaczy, że ważenie jest.
//
// Obie kolumny bazy zostają: `weighing_required` niesie odpowiedź „czy" także wtedy, gdy nikt nie
// wie GDZIE (wtedy w komórce stoi „Tak"), i po niej filtruje się dzień. Zmienia się to, że
// dyspozytor wypełnia JEDNO pole, a appka rozkłada je na dwa.

const TAK = ["tak", "t", "wymagane", "jest", "wymagany", "yes"];
const NIE = ["nie", "n", "niewymagane", "nie wymagane", "brak", "bez wazenia", "no"];

const PL_MAP: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z",
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[ąćęłńóśźż]/g, (ch) => PL_MAP[ch] ?? ch).replace(/\s+/g, " ").trim();
}

export interface WeighingFields {
  weighing_export: string | null;
  weighing_required: boolean | null;
}

/**
 * Co widać w komórce: miejsce ważenia, a gdy miejsca nie znamy — samo „Tak"/„Nie".
 * Puste znaczy „dokument o tym nie mówi" i celowo NIE jest tym samym co „Nie".
 */
export function weighingCellText(load: Partial<WeighingFields>): string {
  const place = (load.weighing_export ?? "").trim();
  if (place) return place;
  if (load.weighing_required === true) return "Tak";
  if (load.weighing_required === false) return "Nie";
  return "";
}

/**
 * Wpisany tekst → oba pola. „tak"/„nie" ustawiają samą odpowiedź, każdy inny tekst jest MIEJSCEM
 * ważenia (i tym samym odpowiedzią „tak"), a puste pole kasuje jedno i drugie.
 */
export function weighingCellPatch(raw: string): WeighingFields {
  const text = raw.trim();
  if (text === "") return { weighing_export: null, weighing_required: null };
  const key = normalize(text);
  if (TAK.includes(key)) return { weighing_export: null, weighing_required: true };
  if (NIE.includes(key)) return { weighing_export: null, weighing_required: false };
  return { weighing_export: text, weighing_required: true };
}
