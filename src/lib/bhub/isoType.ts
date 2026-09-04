// Porównanie typu kontenera ze zlecenia z typem ISO podanym przez terminal.
//
// Właściciel: "Sprawdź ISOtype (długość) i porównaj czy się pokrywa z tą ze zlecenia, jak tak to
// pogrub, jak nie to alarmuj. Jeżeli chodzi o długość kontenera 20DV to 22g1, 20OT to 22UT lub
// 22U1, 40 to 45g1."
//
// PUŁAPKA, dla której ten plik w ogóle istnieje osobno: te dwa zapisy czyta się INACZEJ.
// W zleceniu "40HC" i "45" zaczynają się od długości w stopach (40, 45). W kodzie ISO 6346
// długość niesie TYLKO PIERWSZY znak, a drugi to wysokość — więc "45G1" to kontener
// 40-stopowy high cube, a nie 45-stopowy. Naiwne porównanie dwóch pierwszych cyfr uznałoby
// zlecenie na 45 stóp za zgodne z ISO "45G1", czyli zamilkłoby dokładnie tam, gdzie ma alarmować.
//
// Stąd dwie osobne funkcje długości i test na tę parę (patrz scratch-bhub.test.mts).

export type Agreement = "match" | "mismatch" | "unknown";

// ISO 6346, znak 1 — długość. Bierzemy kody spotykane w obrocie; reszta = null (nie zgadujemy).
const ISO_LENGTH_FEET: Record<string, number> = {
  "1": 10,
  "2": 20,
  "3": 30,
  "4": 40,
  "9": 45, // starszy zapis dla 45 stóp
  L: 45,
  M: 48,
  N: 49,
  P: 53,
};

// ISO 6346, znak 2 — wysokość/szerokość. Interesuje nas tylko, czy to high cube (powyżej 9'0",
// czyli "5" = 9'6" i "6" = wyższy). Zwykła wysokość 8'6" to "2" — stąd 22G1 (20 stóp zwykły) i
// 45G1 (40 stóp high cube) różnią się właśnie tym znakiem, nie pierwszym.
const ISO_HIGH_CUBE = new Set(["5", "6"]);

// ISO 6346, znak 3 — rodzina typu.
const ISO_TYPE_FAMILY: Record<string, ContainerFamily> = {
  G: "DV", // general purpose
  V: "DV", // general purpose z wentylacją
  B: "DV", // bulk — dla nas zamknięty jak zwykły
  U: "OT", // open top
  R: "RF", // chłodnia
  H: "RF", // chłodnia z agregatem zewnętrznym
  T: "TK", // cysterna
  P: "FR", // platforma / flat rack
  S: "DV", // named cargo
};

export type ContainerFamily = "DV" | "OT" | "RF" | "TK" | "FR";

export const FAMILY_LABELS: Record<ContainerFamily, string> = {
  DV: "zwykły",
  OT: "open top",
  RF: "chłodnia",
  TK: "cysterna",
  FR: "platforma",
};

function cleanCode(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[\s'"’\-_.]/g, "");
}

export interface IsoTypeInfo {
  lengthFeet: number | null;
  highCube: boolean;
  family: ContainerFamily | null;
}

// STARY, LICZBOWY zapis typu — tak podaje BCT ("2210" zamiast "22G1"). Dwa ostatnie znaki to
// wtedy grupa typu wg ISO 6346 sprzed zapisu literowego. Mapujemy WYŁĄCZNIE dwie grupy, których
// jesteśmy pewni (0x i 1x to kontenery uniwersalne, z wentylacją i bez) — reszta zostaje "nie
// wiem". To nie jest ostrożność na wyrost: rodzina decyduje o tym, co appka wpisze w "Wielkość",
// a zgadnięty open top pojechałby na dokumencie przewozowym.
const ISO_NUMERIC_FAMILY: Record<string, ContainerFamily> = { "0": "DV", "1": "DV" };

/** Rozbiór kodu ISO 6346 typu "22G1", "45G1", "22U1", "L5G1" oraz liczbowego "2210". */
export function parseIsoType(raw: string | null | undefined): IsoTypeInfo {
  const code = cleanCode(raw);
  if (code.length < 2) return { lengthFeet: null, highCube: false, family: null };
  const liczbowy = code.length >= 4 && /^[0-9]{2}$/.test(code.slice(2, 4));
  return {
    lengthFeet: ISO_LENGTH_FEET[code[0]] ?? null,
    highCube: ISO_HIGH_CUBE.has(code[1]),
    family: liczbowy
      ? (ISO_NUMERIC_FAMILY[code[2]] ?? null)
      : code.length >= 3
        ? (ISO_TYPE_FAMILY[code[2]] ?? null)
        : null,
  };
}

/** Długość ze zlecenia: "20DV" → 20, "40 HC" → 40, "45" → 45. Tu liczba stoi WPROST z przodu. */
export function orderSizeLengthFeet(raw: string | null | undefined): number | null {
  const size = cleanCode(raw);
  const match = size.match(/^(\d{2})/);
  if (!match) return null;
  const feet = Number(match[1]);
  return [10, 20, 30, 40, 45, 48, 49, 53].includes(feet) ? feet : null;
}

/** Rodzina ze zlecenia: "20OT" → OT, "40HC"/"20DV" → DV, "40RF" → RF. */
export function orderSizeFamily(raw: string | null | undefined): ContainerFamily | null {
  const size = cleanCode(raw);
  if (!size) return null;
  if (/OT|OPENTOP/.test(size)) return "OT";
  if (/RF|REEFER|CHLOD|CHŁOD/.test(size)) return "RF";
  if (/TK|TANK|CYSTERN/.test(size)) return "TK";
  if (/FR|FLAT|PLATF/.test(size)) return "FR";
  if (/DV|GP|HC|HQ|DC/.test(size)) return "DV";
  return null;
}

/**
 * Reguła alarmu wprost z prośby właściciela: porównujemy DŁUGOŚĆ. Brak którejkolwiek ze stron
 * (terminal nie podał / zlecenie nie ma wielkości) to `unknown` — nie alarmujemy z powodu braku
 * danych, bo alarm ma znaczyć "coś się nie zgadza", a nie "czegoś jeszcze nie wiemy".
 */
export function compareIsoLength(isoType: string | null | undefined, orderSize: string | null | undefined): Agreement {
  const iso = parseIsoType(isoType).lengthFeet;
  const order = orderSizeLengthFeet(orderSize);
  if (iso === null || order === null) return "unknown";
  return iso === order ? "match" : "mismatch";
}

/**
 * Rodzina typu (zwykły / open top / chłodnia…) — świadomie NIE jest to alarm: właściciel zawęził
 * regułę do długości. Różnica idzie do dymka, żeby dyspozytor zobaczył ją sam, gdy już patrzy na
 * komórkę, ale 20DV podstawione pod 20OT nie zapala czerwonego na całej tabeli bez ustaleń.
 */
export function compareIsoFamily(isoType: string | null | undefined, orderSize: string | null | undefined): Agreement {
  const iso = parseIsoType(isoType).family;
  const order = orderSizeFamily(orderSize);
  if (iso === null || order === null) return "unknown";
  return iso === order ? "match" : "mismatch";
}

/**
 * Kod ISO → zapis „Wielkości" używany w zleceniach: `22G1` → `20 DV`, `45G1` → `40 HC`,
 * `22U1` → `20 OT`, `L5G1` → `45`.
 *
 * Właściciel wprost: „mogłeś też pobrać ISO Type 22G1 i zamienić go na 20 (to jest ich
 * oznaczenie)" — terminal podaje normę ISO, arkusz klienta swój skrót, i to appka ma je pogodzić.
 *
 * Uwaga na czytanie kodu: długość niesie WYŁĄCZNIE pierwszy znak, drugi to wysokość. Dlatego
 * `45G1` to 40 stóp high cube, a NIE 45 stóp (patrz komentarz przy ISO_HIGH_CUBE).
 *
 * Kontenery 45-stopowe zapisujemy samym „45": w obrocie są zawsze high cube, a klient tak je
 * właśnie oznacza w arkuszu. Gdy nie znamy długości albo rodziny — zwracamy `null` i nie
 * wpisujemy niczego; zgadnięta wielkość poszłaby na dokument przewozowy.
 */
export function isoToOrderSize(raw: string | null | undefined): string | null {
  // Kształt kodu sprawdzamy PRZED odczytem: bez tego zwykłe angielskie słowo ze strony terminala
  // („LINK") wychodziło jako kontener 45-stopowy, bo pierwszy znak „L" znaczy w normie 45 stóp.
  // Ta sama klasa błędu wpisała kiedyś do bazy „LINK" i „LEFT" jako typ kontenera (patrz ISO_CODE
  // w supabase/functions/bhub-status/parse.ts) — tu jest jej druga, niezależna straż.
  if (!/^[24L][0-9CDEF](?:[ABGHKNPRSTUV][0-9A-Z]|[0-9]{2})$/.test(cleanCode(raw))) return null;
  const { lengthFeet, highCube, family } = parseIsoType(raw);
  if (lengthFeet === null) return null;
  if (lengthFeet === 45) return "45";
  if (family === null) return null;
  if (family === "DV") return highCube ? `${lengthFeet} HC` : `${lengthFeet} DV`;
  return `${lengthFeet} ${family}`;
}

/** Opis kodu ISO po polsku do dymka: "45G1" → "40 stóp, high cube, zwykły". */
export function describeIsoType(raw: string | null | undefined): string {
  const code = cleanCode(raw);
  if (!code) return "";
  const { lengthFeet, highCube, family } = parseIsoType(code);
  const parts: string[] = [];
  parts.push(lengthFeet === null ? "nieznana długość" : `${lengthFeet} stóp`);
  if (highCube) parts.push("high cube");
  if (family) parts.push(FAMILY_LABELS[family]);
  return `${code} — ${parts.join(", ")}`;
}
