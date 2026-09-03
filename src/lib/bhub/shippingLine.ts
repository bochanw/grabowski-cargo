// Porównanie gestii (armatora) ze zlecenia z armatorem, którego podaje terminal.
// Właściciel: "Sprawdź także czy Gestia się zgadza. Pogrub jak się zgadza, jak nie to alarmuj."
//
// Armator w dokumencie bywa zapisany dowolnie ("MSC", "M.S.C.", "Mediterranean Shipping Company",
// "Hapag Lloyd", "HAPAG-LLOYD AG"), więc porównanie idzie na formie znormalizowanej plus krótkiej
// tablicy aliasów największych linii. Nieznana nazwa NIE jest błędem — porównujemy ją wtedy
// dosłownie po normalizacji.

import type { Agreement } from "./isoType";

export type { Agreement };

// Wartość gestii, którą wpisuje SAMA APPKA, a nie terminal — reguła "Leasing z uwag" (patrz
// src/lib/loads/leasing.ts). Terminal poda wtedy prawdziwego armatora i porównanie zawsze
// wychodziłoby na czerwono, więc taką gestię świadomie zostawiamy bez oceny.
const APP_OWN_VALUES = ["leasing"];

// Formy prawne i słowa bez znaczenia rozróżniającego — odcinane przed porównaniem.
const NOISE = /\b(sp|zoo|spzoo|sa|ag|gmbh|ltd|limited|inc|nv|bv|as|plc|co|company|line|lines|shipping|container|containers|maritime|logistics)\b/g;

// Aliasy dużych linii: wariant zapisu → kanoniczny skrót. Lista celowo krótka — obejmuje to, co
// realnie pada w zleceniach; nieznana nazwa i tak porówna się dosłownie.
//
// Warianty pisane są TAK, JAK STOJĄ W DOKUMENCIE (ze spacjami i formą prawną), a nie w formie
// sklejonej — i przechodzą przez tę samą `normalize`, co porównywana wartość. Pierwsza wersja tego
// pliku miała je sklejone ("mediterraneanshipping") i przez to NIE dopasowywała "Mediterranean
// Shipping Company": normalizacja wycina z prawdziwego tekstu słowa "shipping"/"company", więc
// zostawało samo "mediterranean", czego w tablicy nie było. Złapane testem, nie przy pisaniu —
// stąd reguła: wariant zapisujemy dosłownie, normalizuje go kod.
// Warianty oznaczone "kod terminala" pochodzą WPROST z eksportu Baltic Hub (kolumna "Line
// Operator") — terminal pisze armatora trzyliterowym kodem, a nie nazwą, więc bez nich zgodna
// gestia wychodziłaby jako niezgodna. Potwierdzone na prawdziwym pliku: CMA, OOL, MSC.
const RAW_ALIASES: { canonical: string; variants: string[] }[] = [
  { canonical: "MSC", variants: ["msc", "mediterranean shipping company"] },
  { canonical: "MAERSK", variants: ["maersk", "maersk line", "a.p. moller", "sealand", "msk", "mae"] },
  { canonical: "CMACGM", variants: ["cma cgm", "cma-cgm", "cma"] }, // kod terminala: CMA
  { canonical: "HAPAG", variants: ["hapag", "hapag-lloyd", "hlag", "hlc"] },
  { canonical: "ONE", variants: ["one", "ocean network express", "onе"] },
  { canonical: "EVERGREEN", variants: ["evergreen", "evergreen marine", "emc"] },
  { canonical: "COSCO", variants: ["cosco", "coscon", "cosco shipping", "cos"] },
  { canonical: "HMM", variants: ["hmm", "hyundai merchant marine", "hyundai"] },
  { canonical: "YANGMING", variants: ["yang ming", "yml"] },
  { canonical: "OOCL", variants: ["oocl", "orient overseas", "ool"] }, // kod terminala: OOL
  { canonical: "ZIM", variants: ["zim", "zim integrated"] },
  { canonical: "PIL", variants: ["pil", "pacific international"] },
  { canonical: "ARKAS", variants: ["arkas"] },
  { canonical: "UNIFEEDER", variants: ["unifeeder", "unf"] },
  { canonical: "XPRESSFEEDERS", variants: ["x-press feeders", "xpress", "sea consortium"] },
];

function normalize(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[ąàáâä]/g, "a")
    .replace(/[ćč]/g, "c")
    .replace(/[ęèéêë]/g, "e")
    .replace(/[łl]/g, "l")
    .replace(/[ńñ]/g, "n")
    .replace(/[óòôö]/g, "o")
    .replace(/[śš]/g, "s")
    .replace(/[żźž]/g, "z")
    .replace(/[.,'"’/\\&+]/g, " ")
    .replace(/[-–—_]/g, " ")
    // Polskie formy prawne rozbite kropkami ("Sp. z o.o.", "S.A.") trzeba zdjąć TU, na tekście
    // jeszcze ze spacjami: po sklejeniu "z o o" zamienia się w "zoo" i granice słów (\b) z listy
    // NOISE już go nie widzą — tak przez chwilę "ZIM Sp. z o.o." wychodziło jako "ZIMZOO".
    .replace(/\bsp\s*z\s*o\s*o\b/g, " ")
    .replace(/\bz\s*o\s*o\b/g, " ")
    .replace(/\bs\s+a\b/g, " ")
    .replace(NOISE, " ")
    .replace(/\s+/g, "");
}

// Warianty przepuszczone przez tę samą normalizację co porównywana wartość — patrz komentarz przy
// RAW_ALIASES. Puste odpadają (wariant złożony wyłącznie ze słów wycinanych przez NOISE).
const ALIASES = RAW_ALIASES.map(({ canonical, variants }) => ({
  canonical,
  keys: [...new Set(variants.map(normalize).filter(Boolean))],
}));

/** Kanoniczna postać nazwy armatora — alias, jeśli znany, inaczej sama normalizacja. */
export function canonicalShippingLine(raw: string | null | undefined): string {
  const key = normalize(raw);
  if (!key) return "";
  for (const { canonical, keys } of ALIASES) {
    if (keys.includes(key)) return canonical;
  }
  // Nazwa z dopiskiem ("maerskpolska") — dopasowanie po przedrostku. Próg 5 znaków, żeby krótkie
  // skróty ("one", "pil", "zim") nie łapały przypadkowych nazw zaczynających się tak samo.
  for (const { canonical, keys } of ALIASES) {
    if (keys.some((k) => k.length >= 5 && key.startsWith(k))) return canonical;
  }
  return key.toUpperCase();
}

/**
 * Zgodność gestii. `unknown` (bez pogrubienia i bez alarmu), gdy którakolwiek strona jest pusta
 * albo gdy gestia w zleceniu to nasza własna wartość "Leasing" — porównywanie jej z armatorem
 * terminala nie ma sensu i dawałoby stały fałszywy alarm.
 */
export function compareShippingLine(
  terminalLine: string | null | undefined,
  orderLine: string | null | undefined
): Agreement {
  const orderKey = normalize(orderLine);
  if (!orderKey || APP_OWN_VALUES.includes(orderKey)) return "unknown";
  const terminalKey = normalize(terminalLine);
  if (!terminalKey) return "unknown";
  return canonicalShippingLine(terminalLine) === canonicalShippingLine(orderLine) ? "match" : "mismatch";
}
