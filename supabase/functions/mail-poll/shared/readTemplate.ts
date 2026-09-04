// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/lib/orderTemplates/readTemplate.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

// ============================================================
// CZYTANIE dokumentu nauczonym szablonem — połowa auto-nauki, która musi działać W DWÓCH MIEJSCACH
// ============================================================
// Uczy się wyłącznie przeglądarka (patrz learn.ts), ale CZYTAĆ nauczonym szablonem musi też
// `mail-poll` — inaczej zlecenie przysłane mailem byłoby droższe niż to samo zlecenie wgrane
// ręcznie. Stąd podział: tutaj jest tylko to, co potrzebne do rozpoznania układu i odczytania
// pól, a ten plik jedzie do Deno przez scripts/build-edge-shared.mjs.
//
// Zweryfikowane, że to ma sens: tekst tego samego PDF-a wyciągnięty w przeglądarce i w Deno wyszedł
// IDENTYCZNY co do znaku (6089 znaków, ten sam skrót) — kotwice nauczone u dyspozytora trafiają
// więc tak samo po stronie serwera.

import { EMPTY_PARSED_ORDER, type ParsedOrder } from "./parsedOrder.ts";

export type DocKind = "zlecenie" | "list_przewozowy" | "inne";

/** Jak wartość wygląda w dokumencie w stosunku do tego, co trzymamy w bazie. */
export type LearnKind = "text" | "date" | "time" | "amount" | "count" | "direction" | "container";

/**
 * Jedna wyuczona reguła. Wartość stoi między `before` a `after`; `occurrence` mówi, które z kolei
 * dopasowanie danego typu wziąć z tego kawałka (0 = pierwsze) — używane tylko wtedy, gdy między
 * etykietą a wartością stoi zmienna zawartość, np. w tabeli.
 */
export interface FieldRule {
  before: string;
  after: string;
  kind: LearnKind;
  /** Zapis wartości w dokumencie ("DD.MM.RRRR", "1234,00") — potrzebny, bo w bazie mamy ISO/liczbę. */
  format: string;
  occurrence?: number;
}

export type LearnedField = keyof ParsedOrder;
export type TemplateRules = Partial<Record<LearnedField, FieldRule>>;

/**
 * Pola, bez których nauczony szablon NIE zastępuje płatnego odczytu (decyzja właściciela:
 * "gdy odtworzy komplet kluczowych pól"). Dla listu przewozowego zestaw jest inny nie dla wygody:
 * list z definicji nie zawiera stawki ani zleceniodawcy (to dokument dla kierowcy), więc wymaganie
 * ich blokowałoby naukę tej połowy dokumentów na zawsze.
 */
const KEY_FIELDS: Record<DocKind, LearnedField[]> = {
  zlecenie: ["order_number", "direction", "container_number", "delivery_date", "rate_amount", "forwarder"],
  list_przewozowy: ["order_number", "container_number", "driver_name", "vehicle_plate"],
  inne: ["order_number", "direction", "container_number", "delivery_date", "rate_amount", "forwarder"],
};

// ------------------------------------------------------------
// Rozpoznanie układu dokumentu
// ------------------------------------------------------------

/**
 * "Odcisk palca" układu: zbiór etykiet dokumentu. Dwa zlecenia od tego samego spedytora mają te same
 * rubryki i inne wartości — więc porównujemy rubryki, nie treść.
 */
export function documentLabels(text: string): string[] {
  const labels = new Set<string>();
  for (const match of text.matchAll(/([\p{L}][\p{L}\s/.\-()]{2,38}):/gu)) {
    const label = match[1].replace(/\s+/g, " ").trim().toLowerCase();
    if (label.length >= 3) labels.add(label);
  }
  // Nie każdy layout używa dwukropków — nagłówki pisane wersalikami niosą tę samą informację
  // ("ZLECENIE SPEDYCYJNE", "MIEJSCE PODJĘCIA KONTENERA").
  for (const match of text.matchAll(/\b\p{Lu}{3,}(?:\s+\p{Lu}{2,}){0,5}\b/gu)) {
    const label = match[0].replace(/\s+/g, " ").trim().toLowerCase();
    if (label.length >= 4) labels.add(label);
  }
  return [...labels].slice(0, 120);
}

/** Podobieństwo dwóch zbiorów etykiet (Jaccard): 1 = ten sam układ, 0 = nic wspólnego. */
export function labelSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let common = 0;
  for (const label of setA) if (setB.has(label)) common += 1;
  return common / (setA.size + setB.size - common);
}

/** Od tego progu uznajemy, że to ten sam układ dokumentu. */
export const SAME_LAYOUT_THRESHOLD = 0.6;

/**
 * Rodzaj dokumentu z jego treści. Decyduje ten znacznik, który stoi WCZEŚNIEJ — tytuł jest na
 * górze, a zlecenie spedycyjne wspomina o liście przewozowym w warunkach płatności ("60 dni od
 * daty wpływu faktury i listu przewozowego") i bez tej reguły brało to za swój tytuł (złapane
 * testem na prawdziwym zleceniu Q4Road).
 */
export function guessDocKindFromText(text: string): DocKind {
  const waybill = text.search(/list\s+przewozowy|listu\s+przewozowego|waybill|\bcmr\b/i);
  const order = text.search(/zlecenie\s+(spedycyjne|transportowe)|zlecenie\s+nr|transport\s+order/i);
  if (waybill === -1 && order === -1) return "inne";
  if (order === -1) return "list_przewozowy";
  if (waybill === -1) return "zlecenie";
  return waybill < order ? "list_przewozowy" : "zlecenie";
}

/** Wzorce, po których rozpoznajemy wartość danego typu w kawałku tekstu między kotwicami. */
export const TYPED_PATTERNS: Partial<Record<LearnKind, RegExp>> = {
  date: /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}|\d{4}-\d{2}-\d{2}/g,
  time: /\b\d{1,2}:\d{2}\b/g,
  amount: /-?\d[\d\s .]*(?:[.,]\d+)?/g,
  count: /-?\d[\d\s .]*(?:[.,]\d+)?/g,
  // Trzeci typ zlecenia (krajówka) — w dokumentach pisany różnie, stąd oba warianty ortograficzne
  // i „transport krajowy". Kolejność w alternatywie bez znaczenia: dopasowania nie zachodzą na siebie.
  direction: /import|eksport|export|krajówka|krajowka|krajowy/gi,
  container: /\b[A-Za-z]{4}\s?\d{7}\b/g,
};

/** Jeden zapis z dokumentu → wartość w kształcie, w jakim trzyma ją appka. */
export function parseOne(raw: string, kind: LearnKind, format: string): string | number | null {
  const value = raw.trim();
  if (!value) return null;

  if (kind === "direction") {
    if (/^import/i.test(value)) return "I";
    if (/^(eksport|export)/i.test(value)) return "E";
    if (/^(krajówka|krajowka|krajow)/i.test(value)) return "K";
    return null;
  }

  if (kind === "date") {
    const iso = value.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (format === "RRRR-MM-DD" && iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const dmy = value.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
    return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }

  if (kind === "amount" || kind === "count") {
    const cleaned = value.replace(/[\s ]/g, "");
    // "3.296,00" → przecinek dziesiętny; "3296.00" → kropka dziesiętna.
    const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }

  return value;
}

// ------------------------------------------------------------
// Czytanie dokumentu nauczonym szablonem
// ------------------------------------------------------------

/** Kawałek tekstu między kotwicami — albo null, gdy kotwica nie trafia albo trafia dwuznacznie. */
export function chunkBetween(text: string, rule: FieldRule): string | null {
  const start = text.indexOf(rule.before);
  // Kotwica, która trafia w dokument dwa razy, przestała być etykietą tego pola — lepiej zostawić
  // pole puste (dyspozytor je uzupełni) niż wpisać wartość z przypadkowego miejsca.
  if (start === -1 || start !== text.lastIndexOf(rule.before)) return null;
  const rest = text.slice(start + rule.before.length);
  const end = rest.indexOf(rule.after);
  return end === -1 ? null : rest.slice(0, end);
}

function readRule(text: string, rule: FieldRule): string | number | null {
  const chunk = chunkBetween(text, rule);
  if (chunk === null) return null;
  if (rule.kind === "text") return parseOne(chunk, rule.kind, rule.format);

  const pattern = TYPED_PATTERNS[rule.kind];
  if (!pattern) return null;
  const matches = [...chunk.matchAll(pattern)];
  const hit = matches[rule.occurrence ?? 0];
  return hit ? parseOne(hit[0], rule.kind, rule.format) : null;
}

export function applyRules(text: string, rules: TemplateRules): ParsedOrder {
  const out: ParsedOrder = { ...EMPTY_PARSED_ORDER };
  for (const [field, rule] of Object.entries(rules) as [LearnedField, FieldRule][]) {
    const value = readRule(text, rule);
    if (value === null || value === "") continue;
    (out as unknown as Record<string, unknown>)[field] = value;
  }
  return out;
}

// ------------------------------------------------------------
// Kiedy nauczony szablon wystarcza sam
// ------------------------------------------------------------

/** Czy szablon odczytał komplet pól, bez których nie wolno mu zastąpić płatnego odczytu. */
export function missingKeyFields(parsed: ParsedOrder, kind: DocKind): LearnedField[] {
  return KEY_FIELDS[kind].filter((field) => {
    const value = parsed[field];
    return value === null || value === undefined || value === "";
  });
}

/** Pola, których szablon nie musi czytać z dokumentu, bo wynikają z jego TOŻSAMOŚCI. */
export interface TemplateIdentity {
  forwarder_name?: string | null;
  forwarder_nip?: string | null;
}

/**
 * Zleceniodawca nie jest polem do odczytania, tylko tym, po czym rozpoznaliśmy szablon — nazwa
 * i NIP z dokumentu bywają zresztą w dwóch miejscach naraz (nagłówek i "fakturę proszę wystawić
 * na…"), więc kotwica na nich i tak nie powstanie. Skoro szablon pasuje, to wiadomo, kto go wysłał.
 */
export function withIdentity(parsed: ParsedOrder, identity: TemplateIdentity): ParsedOrder {
  return {
    ...parsed,
    forwarder: parsed.forwarder || (identity.forwarder_name ?? ""),
    forwarder_nip: parsed.forwarder_nip || (identity.forwarder_nip ?? ""),
  };
}

export function digitsOnly(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

// ------------------------------------------------------------
// Dopasowanie dokumentu do nauczonych szablonów
// ------------------------------------------------------------

/** Tyle szablonu potrzebuje dopasowanie — dzięki temu ten plik nie wie nic o bazie ani o Supabase. */
export interface LearnedTemplateLike extends TemplateIdentity {
  id: string;
  label: string;
  doc_kind: DocKind;
  labels: string[];
  rules: TemplateRules;
  status: string;
}

export interface LearnedMatch<T extends LearnedTemplateLike> {
  template: T;
  parsed: ParsedOrder;
  similarity: number;
  /** Puste = szablon wystarcza sam; niepuste = trzeba dołożyć płatny odczyt. */
  missing: LearnedField[];
}

/**
 * Najlepszy nauczony szablon dla tego dokumentu — albo nic.
 *
 * Dwa warunki naraz, bo każdy z osobna bywa mylący: układ rubryk musi się zgadzać (Jaccard etykiet),
 * a NIP spedytora — jeśli szablon go zna — musi stać w dokumencie. Same etykiety bywają podobne
 * u dwóch spedytorów korzystających z tego samego programu do zleceń, a sam NIP potrafi się trafić
 * w cudzej stopce.
 */
export function matchLearnedTemplate<T extends LearnedTemplateLike>(
  text: string,
  templates: T[]
): LearnedMatch<T> | null {
  const labels = documentLabels(text);
  const digits = digitsOnly(text);
  let best: LearnedMatch<T> | null = null;

  for (const template of templates) {
    if (template.status !== "aktywny") continue;
    const nip = digitsOnly(template.forwarder_nip);
    if (nip.length >= 9 && !digits.includes(nip)) continue;
    const similarity = labelSimilarity(labels, template.labels);
    if (similarity < SAME_LAYOUT_THRESHOLD) continue;
    if (best && similarity <= best.similarity) continue;

    const parsed = withIdentity(applyRules(text, template.rules), template);
    best = { template, parsed, similarity, missing: missingKeyFields(parsed, template.doc_kind) };
  }
  return best;
}
