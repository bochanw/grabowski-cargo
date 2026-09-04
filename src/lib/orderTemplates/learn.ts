// ============================================================
// AUTO-NAUKA SZABLONÓW — z jednorazowego odczytu przez Claude robi darmowy, deterministyczny parser
// ============================================================
// Właściciel: "pomyśl jak to zrobić, żeby automatycznie odczyt zlecenia jednorazowy przez AI był
// traktowany jako znany szablon, taka auto-nauka".
//
// SKĄD BIERZEMY PRAWDĘ: nie z odpowiedzi modelu, tylko z pól ZATWIERDZONYCH przez dyspozytora przy
// zapisie zlecenia. Model czyta, człowiek poprawia, a appka dopiero POTEM szuka zatwierdzonych
// wartości w tekście dokumentu. Uczymy się więc z danych sprawdzonych, a nie z domysłu modelu.
//
// CZEGO SIĘ UCZYMY: kotwic "co stoi przed wartością" i "co stoi po niej" — tego samego, co ręcznie
// napisany q4road.ts robi przez `between()`. Żadnych wyuczonych pozycji w tekście: te rozjeżdżają
// się przy pierwszym dłuższym adresie.
//
// DLACZEGO DOPIERO DRUGI DOKUMENT (wybór właściciela): z JEDNEGO dokumentu nie da się odróżnić
// etykiety od sąsiedniej wartości — przed numerem kontenera stoi "…20DV ONE Numer kontenera:",
// a pierwsza połowa tego zmienia się co zlecenie. Mając DWA dokumenty tego samego układu bierzemy
// wspólny koniec tego, co poprzedza wartość, i wspólny początek tego, co po niej następuje — czyli
// dokładnie to, co w obu dokumentach jest STAŁE. Reszta odpada sama, bez zgadywania.
//
// DWIE RZECZY ZŁAPANE TESTEM NA PRAWDZIWYM ZLECENIU (obie zmieniły projekt, nie tylko kod):
//  1. Wspólna część dwóch dokumentów WCIĄŻ bywa daną, a nie etykietą — dwa zlecenia potrafią mieć
//     ten sam rozładunek albo tę samą agencję celną. Kotwica z taką daną w środku działa na obu
//     dokumentach, z których się uczyliśmy, i rozsypuje się na trzecim. Dlatego z kotwic wycinamy
//     WSZYSTKO, co wygląda na daną (znane wartości, także urwane na brzegu okna, oraz daty, kwoty
//     i długie liczby, których appka w ogóle nie zapisuje — jak data wystawienia).
//  2. W tych dokumentach data i godzina stoją w TABELI, gdzie obok wartości nie ma żadnej etykiety
//     — jest poprzednia rubryka. Kotwica "tuż przy wartości" nie istnieje, więc reguła może
//     przeskoczyć zmienną zawartość: kotwiczy na najbliższej STAŁEJ etykiecie i bierze n-tą datę
//     (godzinę, kwotę) z tego kawałka. Dla pól tekstowych na to nie pozwalamy — "n-ty tekst"
//     nic nie znaczy.
//
// STRAŻ, bez której to byłoby niebezpieczne (błędny szablon jest gorszy niż płatny odczyt — wchodzi
// cicho na fakturę): każda reguła musi ODTWORZYĆ zatwierdzone wartości w OBU dokumentach, co do
// znaku. Reguła, która tego nie zrobi, nie trafia do szablonu. To ta sama lekcja co pułapka
// z kotwicą `$` w CLAUDE.md: reguła sprawdzana na tej samej ścieżce, którą pójdzie produkcja.

import type { ParsedOrder } from "@/types/parsedOrder";
import {
  applyRules,
  chunkBetween,
  parseOne,
  TYPED_PATTERNS,
  type FieldRule,
  type LearnedField,
  type LearnKind,
  type TemplateRules,
} from "./readTemplate";

// Czytanie nauczonym szablonem siedzi w readTemplate.ts (ten sam kod działa w przeglądarce i w
// `mail-poll`). Świadomie BEZ `export *`: wołający ma importować wprost stamtąd, gdzie rzecz leży —
// re-eksport gubił się w narzędziach, które inaczej rozwiązują ESM.

// Pola, których w ogóle próbujemy się uczyć. Świadomie NIE MA tu:
//  • load_date i gross_weight — appka je WYLICZA (dzień roboczy przed rozładunkiem, towar + tara),
//    więc w dokumencie ich nie ma i szukanie ich byłoby szukaniem czegoś, czego nikt nie napisał;
//  • baf_percentage i rate_includes_baf — to interpretacja zdania ("w tym BAF"), nie wartość
//    stojąca w rubryce; od takiego rozumienia jest model;
//  • weighing_required — z tego samego powodu: dokument pisze "ważenie w porcie", a nie "tak".
//    Samo MIEJSCE ważenia (weighing_place) stoi w rubryce i uczy się normalnie.
const LEARNABLE: Partial<Record<LearnedField, LearnKind>> = {
  order_number: "text",
  forwarder: "text",
  forwarder_nip: "text",
  forwarder_address: "text",
  forwarder_postal_code: "text",
  forwarder_city: "text",
  direction: "direction",
  container_number: "container",
  container_size: "text",
  shipping_line: "text",
  company_name: "text",
  address: "text",
  city: "text",
  postal_code: "text",
  delivery_date: "date",
  delivery_time: "time",
  customs_location_or_status: "text",
  rate_amount: "amount",
  rate_currency: "text",
  payment_terms_days: "count",
  payment_terms_note: "text",
  notes: "text",
  pickup_type: "text",
  pin_booking: "text",
  seal_number: "text",
  goods_name: "text",
  weighing_place: "text",
  net_weight_kg: "amount",
  submitted_when: "text",
  submitted_where: "text",
  driver_name: "text",
  driver_id_number: "text",
  vehicle_plate: "text",
  trailer_plate: "text",
  driver_phone: "text",
};

// Ile tekstu wokół wartości oglądamy, szukając wspólnej części dwóch dokumentów.
const BEFORE_WINDOW = 220;
const AFTER_WINDOW = 140;
// Ile z tego zostaje w gotowej regule — dłuższa kotwica jest pewniejsza, ale nieczytelna w oknie
// "Szablony", a dyspozytor ma móc zobaczyć, czym appka się kieruje.
const MAX_BEFORE = 60;
const MAX_AFTER = 40;
// Wartość krótsza niż to trafia w tekst przypadkiem ("PL", "20"), więc jej nie kotwiczymy.
const MIN_VALUE = 3;
// Tyle znaków wartości urwanej na brzegu okna wystarczy, żeby uznać ją za daną, nie etykietę.
const MIN_PARTIAL = 3;

interface Candidate {
  text: string;
  format: string;
}

/**
 * Jak ta sama wartość może być zapisana w dokumencie, od najbardziej szczegółowego zapisu.
 * Kolejność ma znaczenie finansowe: gdyby kwota 3296,00 nauczyła się jako "3296" z kotwicą ",00",
 * to zlecenie za 1875,50 przestałoby się czytać (złapane testem).
 */
function candidates(value: unknown, kind: LearnKind): Candidate[] {
  if (value === null || value === undefined || value === "") return [];

  if (kind === "direction") {
    if (value === "I") {
      return [{ text: "Import", format: "Import" }, { text: "IMPORT", format: "Import" }, { text: "import", format: "Import" }];
    }
    // Krajówka MUSI mieć własne warianty — bez tego wpadałaby do gałęzi eksportu i szablon
    // kotwiczyłby się na słowie "Eksport", którego w dokumencie krajówki nie ma (albo, gorzej,
    // stoi tam przy czymś innym).
    if (value === "K") {
      return [
        { text: "Krajówka", format: "Krajówka" },
        { text: "KRAJÓWKA", format: "Krajówka" },
        { text: "krajówka", format: "Krajówka" },
        { text: "Krajowka", format: "Krajówka" },
        { text: "krajowy", format: "Krajówka" },
        { text: "Transport krajowy", format: "Krajówka" },
      ];
    }
    return [
          { text: "Eksport", format: "Eksport" },
          { text: "EKSPORT", format: "Eksport" },
          { text: "Export", format: "Eksport" },
          { text: "EXPORT", format: "Eksport" },
          { text: "eksport", format: "Eksport" },
          { text: "export", format: "Eksport" },
        ];
  }

  if (kind === "date") {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return [];
    const [, y, m, d] = match;
    return [
      { text: `${d}.${m}.${y}`, format: "DD.MM.RRRR" },
      { text: `${d}/${m}/${y}`, format: "DD/MM/RRRR" },
      { text: `${d}-${m}-${y}`, format: "DD-MM-RRRR" },
      { text: `${y}-${m}-${d}`, format: "RRRR-MM-DD" },
      { text: `${Number(d)}.${Number(m)}.${y}`, format: "D.M.RRRR" },
    ];
  }

  if (kind === "amount" || kind === "count") {
    const num = Number(value);
    if (!Number.isFinite(num)) return [];
    const whole = Math.trunc(num);
    const grouped = whole.toLocaleString("pl-PL");
    const out: Candidate[] = [];
    if (Number.isInteger(num)) {
      if (kind === "amount") {
        out.push({ text: `${grouped},00`, format: "1 234,00" });
        out.push({ text: `${whole},00`, format: "1234,00" });
        out.push({ text: `${whole}.00`, format: "1234.00" });
      }
      out.push({ text: grouped, format: "1 234" });
      out.push({ text: String(whole), format: "1234" });
    } else {
      const fixed = num.toFixed(2);
      const decimals = fixed.split(".")[1];
      out.push({ text: `${grouped},${decimals}`, format: "1 234,00" });
      out.push({ text: fixed.replace(".", ","), format: "1234,00" });
      out.push({ text: fixed, format: "1234.00" });
    }
    // Bez duplikatów: dla kwot poniżej tysiąca "1 234" i "1234" to ten sam ciąg.
    return out.filter((c, i) => out.findIndex((o) => o.text === c.text) === i);
  }

  const text = String(value).trim();
  return text ? [{ text, format: "tekst" }] : [];
}

// ------------------------------------------------------------
// Uczenie z dwóch dokumentów
// ------------------------------------------------------------

export interface LearningSample {
  text: string;
  values: ParsedOrder;
}

interface Located {
  index: number;
  length: number;
  format: string;
}

/** Gdzie w tekście stoi ta wartość — tylko gdy stoi DOKŁADNIE RAZ (inaczej kotwica jest zgadywaniem). */
function locate(text: string, value: unknown, kind: LearnKind): Located | null {
  for (const candidate of candidates(value, kind)) {
    if (candidate.text.length < MIN_VALUE && kind !== "count") continue;
    const first = text.indexOf(candidate.text);
    if (first === -1 || first !== text.lastIndexOf(candidate.text)) continue;
    return { index: first, length: candidate.text.length, format: candidate.format };
  }
  return null;
}

function commonSuffix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return a.slice(a.length - i);
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

// Wzorce "to na pewno jest DANA, nie etykieta". Dokument niesie ich więcej, niż appka zapisuje
// w zleceniu (data wystawienia, numer faktury, waga wg armatora), więc samo wycięcie znanych
// wartości nie wystarcza.
const VALUE_LOOKING = [
  /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}/g,
  /\d{4}-\d{2}-\d{2}/g,
  /\b\d{1,2}:\d{2}\b/g,
  /\d+[.,]\d{2}\b/g,
  /\b\d{3,}\b/g,
];

/** Fragmenty kotwicy, które są DANĄ — także urwane na brzegu okna (wtedy widać tylko ich kawałek). */
function valueRanges(fragment: string, values: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const value of values) {
    if (value.length < MIN_VALUE) continue;
    let at = fragment.indexOf(value);
    while (at !== -1) {
      ranges.push([at, at + value.length]);
      at = fragment.indexOf(value, at + 1);
    }
    // Wartość urwana na początku fragmentu (widać jej koniec) i na końcu (widać początek).
    for (let k = Math.min(value.length - 1, fragment.length); k >= MIN_PARTIAL; k--) {
      if (fragment.startsWith(value.slice(value.length - k))) {
        ranges.push([0, k]);
        break;
      }
    }
    for (let k = Math.min(value.length - 1, fragment.length); k >= MIN_PARTIAL; k--) {
      if (fragment.endsWith(value.slice(0, k))) {
        ranges.push([fragment.length - k, fragment.length]);
        break;
      }
    }
  }
  for (const pattern of VALUE_LOOKING) {
    for (const match of fragment.matchAll(pattern)) {
      if (match.index !== undefined) ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

/** Fragmenty kotwicy, które NIE są daną — kandydaci na etykietę, w kolejności występowania. */
function stableRuns(fragment: string, values: string[]): { text: string; start: number; end: number }[] {
  const covered = new Array<boolean>(fragment.length).fill(false);
  for (const [from, to] of valueRanges(fragment, values)) {
    for (let i = Math.max(0, from); i < Math.min(fragment.length, to); i++) covered[i] = true;
  }
  const runs: { text: string; start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= fragment.length; i++) {
    if (i < fragment.length && !covered[i]) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      runs.push({ text: fragment.slice(start, i), start, end: i });
      start = -1;
    }
  }
  return runs;
}

/** Wszystko, co w tych dokumentach jest wartością pola — do wycięcia z kotwic. */
function sampleValueStrings(samples: LearningSample[]): string[] {
  const out: string[] = [];
  for (const sample of samples) {
    for (const [field, kind] of Object.entries(LEARNABLE) as [LearnedField, LearnKind][]) {
      for (const candidate of candidates(sample.values[field], kind)) out.push(candidate.text);
    }
  }
  return out;
}

function isUnique(text: string, needle: string): boolean {
  const first = text.indexOf(needle);
  return first !== -1 && first === text.lastIndexOf(needle);
}

/**
 * Reguły wspólne dla DWÓCH dokumentów tego samego układu — sedno auto-nauki.
 *
 * Dla każdego pola: znajdź wartość w obu tekstach, weź wspólny koniec tego, co ją poprzedza, i
 * wspólny początek tego, co po niej następuje, wytnij z tego dane i zostaw etykiety.
 */
export function deriveRules(a: LearningSample, b: LearningSample): TemplateRules {
  const rules: TemplateRules = {};
  const values = sampleValueStrings([a, b]);

  for (const [field, kind] of Object.entries(LEARNABLE) as [LearnedField, LearnKind][]) {
    const valueA = a.values[field];
    const valueB = b.values[field];
    if (valueA === null || valueA === "" || valueB === null || valueB === "") continue;

    const hitA = locate(a.text, valueA, kind);
    const hitB = locate(b.text, valueB, kind);
    if (!hitA || !hitB || hitA.format !== hitB.format) continue;

    // Etykiety szukamy OSOBNO w każdym dokumencie, a dopiero potem zestawiamy ze sobą.
    //
    // Naiwne "wspólna końcówka obu okien" nie działa: gdy przed wartością stoi INNA wartość (inne
    // miasto rozładunku w kolejnym zleceniu), wspólna końcówka urywa się na niej i nie sięga do
    // etykiety stojącej wcześniej. Data i godzina z tabeli były wtedy nie do nauczenia — złapane
    // testem na prawdziwej parze zleceń.
    const beforeRunsA = stableRuns(a.text.slice(Math.max(0, hitA.index - BEFORE_WINDOW), hitA.index), values);
    const beforeRunsB = stableRuns(b.text.slice(Math.max(0, hitB.index - BEFORE_WINDOW), hitB.index), values);
    const afterRunsA = stableRuns(a.text.slice(hitA.index + hitA.length, hitA.index + hitA.length + AFTER_WINDOW), values);
    const afterRunsB = stableRuns(b.text.slice(hitB.index + hitB.length, hitB.index + hitB.length + AFTER_WINDOW), values);

    // Kandydaci na kotwicę przed wartością — od najbliższej. Sama interpunkcja (" | ") wystarczy
    // tylko wtedy, gdy w obu dokumentach występuje jeden raz: jest wtedy równie dobrym
    // drogowskazem co słowo, a bez tego numer zlecenia stojący zaraz po nagłówku byłby nie do
    // nauczenia.
    const beforeCandidates: string[] = [];
    for (let i = beforeRunsA.length - 1; i >= 0; i--) {
      for (let j = beforeRunsB.length - 1; j >= 0; j--) {
        const shared = commonSuffix(beforeRunsA[i].text, beforeRunsB[j].text).slice(-MAX_BEFORE);
        if (!shared || beforeCandidates.includes(shared)) continue;
        const usable = /\p{L}/u.test(shared) || (shared.trim().length >= 1 && isUnique(a.text, shared) && isUnique(b.text, shared));
        if (usable) beforeCandidates.push(shared);
      }
    }
    const afterCandidates: string[] = [];
    for (const runA of afterRunsA) {
      for (const runB of afterRunsB) {
        const shared = commonPrefix(runA.text, runB.text).slice(0, MAX_AFTER);
        if (shared && !afterCandidates.includes(shared)) afterCandidates.push(shared);
      }
    }

    // Pierwsza para kotwic, przy której wartość faktycznie DA SIĘ odczytać w obu dokumentach.
    // Brania "pierwszej z brzegu" nie da się obronić: kotwicą po wartości bywa sama spacja, która
    // ucina kawałek tekstu, zanim w ogóle dojdzie do wartości (data w tabeli — złapane testem).
    let chosen: FieldRule | null = null;
    for (const beforeCandidate of beforeCandidates) {
      for (const afterCandidate of afterCandidates) {
        const rule: FieldRule = { before: beforeCandidate, after: afterCandidate, kind, format: hitA.format };
        if (kind === "text") {
          // Pole tekstowe musi stać między kotwicami SAMO — "n-ty tekst z tego kawałka" nie znaczy nic.
          const chunkA = chunkBetween(a.text, rule);
          const chunkB = chunkBetween(b.text, rule);
          if (chunkA === null || chunkB === null) continue;
          if (chunkA.trim() !== String(valueA).trim() || chunkB.trim() !== String(valueB).trim()) continue;
        } else {
          // Pole rozpoznawalne po KSZTAŁCIE (data, godzina, kwota, kierunek, kontener) może stać
          // dalej od etykiety — bierzemy to samo z kolei dopasowanie w obu dokumentach.
          const occurrenceA = occurrenceOf(a.text, rule, valueA);
          const occurrenceB = occurrenceOf(b.text, rule, valueB);
          if (occurrenceA === null || occurrenceA !== occurrenceB) continue;
          if (occurrenceA > 0) rule.occurrence = occurrenceA;
        }
        chosen = rule;
        break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    rules[field] = chosen;
  }

  // Kontrola na tej samej ścieżce, którą pójdzie produkcja: reguła zostaje TYLKO, jeśli odtwarza
  // zatwierdzone wartości w OBU dokumentach. Bez tego szablon wyglądałby na nauczony, a wpisywałby
  // do zlecenia treść z sąsiedniej rubryki.
  const checkA = applyRules(a.text, rules);
  const checkB = applyRules(b.text, rules);
  for (const field of Object.keys(rules) as LearnedField[]) {
    if (!sameValue(checkA[field], a.values[field]) || !sameValue(checkB[field], b.values[field])) {
      delete rules[field];
    }
  }
  return rules;
}

/** Które z kolei dopasowanie danego typu w kawałku między kotwicami jest naszą wartością. */
function occurrenceOf(text: string, rule: FieldRule, value: unknown): number | null {
  const chunk = chunkBetween(text, rule);
  if (chunk === null) return null;
  const pattern = TYPED_PATTERNS[rule.kind];
  if (!pattern) return null;
  const matches = [...chunk.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    if (sameValue(parseOne(matches[i][0], rule.kind, rule.format), value)) return i;
  }
  return null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a).trim() === String(b).trim();
}

