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

// ============================================================
// Ten sam numer zapisany w INNEJ KOLEJNOŚCI CZŁONÓW
//
// Zgłoszenie właściciela: jeden dokument miał "KPB / 87", drugi "87 / KPB" — "to to samo w sumie",
// a appka założyła drugie zlecenie, bo porównanie znaków po kolei daje "KPB87" ≠ "87KPB".
// Rozbijamy więc numer na człony (po separatorach ORAZ na granicy litera↔cyfra, żeby "zd1797"
// znaczyło to samo co "ZD/1797") i porównujemy zbiór członów, nie ich kolejność.
// ============================================================
export function orderNumberSegments(value: string | null | undefined): string[] {
  return (value ?? "")
    .toUpperCase()
    .replace(/([A-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Z])/g, "$1 $2")
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/**
 * Klucz porównania odporny na kolejność członów. Pusty ciąg = numer nie nadaje się do takiego
 * dopasowania.
 *
 * Warunek "człony muszą być w zapisie ROZDZIELONE separatorem" nie jest kosmetyczny: bez niego
 * "TIIU218" (numer pisany jednym ciągiem) rozpadałby się na TIIU + 218 i trafiał w wymyślone
 * "218/TIIU" — złapane testem. Przestawienie członów ma sens tylko tam, gdzie dokument sam je
 * rozdzielił, czyli dokładnie w przypadku zgłoszonym przez właściciela ("KPB / 87" i "87 / KPB").
 */
export function orderNumberLooseKey(value: string | null | undefined): string {
  if (normalizeOrderNumber(value).length < MIN_ORDER_NUMBER_LENGTH) return "";
  const separated = (value ?? "").trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (separated.length < 2) return "";
  // Klucz liczymy z PEŁNEJ segmentacji (także po granicy litera/cyfra), żeby "zd1797/6/2026"
  // znaczyło to samo co "ZD/1797/6/2026".
  return [...orderNumberSegments(value)].sort().join("|");
}

// ============================================================
// Numer kontenera jako drugi sygnał
//
// Właściciel dopisał przy tym samym zgłoszeniu: "Nr kontenera się pokrywa". Numer ISO (4 litery +
// 7 cyfr) jest na tyle charakterystyczny, że trafienie nie bywa przypadkowe — ale TEN SAM kontener
// wraca po tygodniach na zupełnie inne zlecenie, więc na tej podstawie NIGDY nie łączymy nic po
// cichu: to podpowiedź do potwierdzenia przez dyspozytora (patrz `auto` w `matchExistingLoad`).
// ============================================================
export const MIN_CONTAINER_NUMBER_LENGTH = 6;

export function normalizeContainerNumber(value: string | null | undefined): string {
  return (value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function sameContainerNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeContainerNumber(a);
  const right = normalizeContainerNumber(b);
  return left.length >= MIN_CONTAINER_NUMBER_LENGTH && left === right;
}

/** Kontenery sprzeczne = OBA znane i różne. Brak jednego z nich niczemu nie przeczy. */
function containersConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeContainerNumber(a);
  const right = normalizeContainerNumber(b);
  if (left.length < MIN_CONTAINER_NUMBER_LENGTH || right.length < MIN_CONTAINER_NUMBER_LENGTH) return false;
  return left !== right;
}

export type LoadMatchConfidence = "exact" | "reordered" | "container";

export interface LoadMatch<T> {
  load: T;
  confidence: LoadMatchConfidence;
  /** true = wchodzimy w tryb uzupełniania sami; false = pytamy dyspozytora, zanim cokolwiek scalimy. */
  auto: boolean;
  /** Zdanie do pokazania w oknie importu — dyspozytor ma wiedzieć, CZEMU appka to skojarzyła. */
  reason: string;
}

interface MatchableLoad {
  order_number: string | null;
  container_number?: string | null;
}

/**
 * Zlecenie, do którego pasuje właśnie wczytany dokument — podstawa reguły "drugi dokument do tego
 * samego zlecenia nie tworzy nowego rekordu, tylko uzupełnia brakujące pola".
 *
 * Kolejność sygnałów od najmocniejszego: ten sam numer → ten sam numer inaczej poskładany →
 * ten sam kontener. Pierwszy trafiony wygrywa; dalej nie szukamy, żeby słabszy sygnał nie
 * przebił mocniejszego.
 */
export function matchExistingLoad<T extends MatchableLoad>(
  loads: T[],
  document: { order_number?: string | null; container_number?: string | null }
): LoadMatch<T> | null {
  const exactKey = normalizeOrderNumber(document.order_number);
  if (exactKey.length >= MIN_ORDER_NUMBER_LENGTH) {
    const exact = loads.find((load) => normalizeOrderNumber(load.order_number) === exactKey);
    if (exact) {
      return {
        load: exact,
        confidence: "exact",
        auto: true,
        reason: containersConflict(document.container_number, exact.container_number)
          ? `ten sam numer zlecenia, ale kontener z dokumentu (${document.container_number}) różni się od zapisanego (${exact.container_number}) — sprawdź, który jest właściwy`
          : "ten sam numer zlecenia",
      };
    }
  }

  const looseKey = orderNumberLooseKey(document.order_number);
  if (looseKey) {
    const reordered = loads.find((load) => orderNumberLooseKey(load.order_number) === looseKey);
    if (reordered) {
      const conflict = containersConflict(document.container_number, reordered.container_number);
      return {
        load: reordered,
        confidence: "reordered",
        // Człony te same, ale w innej kolejności — pewne dopóki kontener temu nie przeczy.
        auto: !conflict,
        reason: conflict
          ? `numer ${document.order_number} to te same człony co ${reordered.order_number}, ale kontenery są różne (${document.container_number} vs ${reordered.container_number})`
          : `numer ${document.order_number} zapisany inaczej niż ${reordered.order_number} — te same człony, inna kolejność`,
      };
    }
  }

  const container = normalizeContainerNumber(document.container_number);
  if (container.length >= MIN_CONTAINER_NUMBER_LENGTH) {
    const byContainer = loads.find((load) => normalizeContainerNumber(load.container_number) === container);
    if (byContainer) {
      return {
        load: byContainer,
        confidence: "container",
        // Ten sam kontener wraca na kolejne zlecenia — samo to nie wystarcza, żeby scalić rekordy.
        auto: false,
        reason: `kontener ${document.container_number} jest już na zleceniu ${byContainer.order_number ?? "(bez numeru)"}, ale numery zleceń się różnią`,
      };
    }
  }

  return null;
}

/**
 * Warianty numeru do szukania w SUROWYM tekście (temat/treść maila), gdzie nie ma z czym
 * porównywać kluczy — trzeba mieć gotowe ciągi. Same człony w każdej kolejności, sklejone bez
 * separatorów, bo tekst i tak jest normalizowany. Numery o więcej niż 3 członach zostawiamy przy
 * jednej formie: permutacji byłoby 24+, a im więcej wariantów, tym łatwiej o trafienie przypadkowe.
 */
export function orderNumberVariants(value: string | null | undefined): string[] {
  const exact = normalizeOrderNumber(value);
  if (exact.length < MIN_ORDER_NUMBER_LENGTH) return [];
  // Ten sam warunek co w `orderNumberLooseKey`: przestawiamy tylko człony faktycznie rozdzielone.
  if (!orderNumberLooseKey(value)) return [exact];
  const segments = orderNumberSegments(value);
  if (segments.length > 3) return [exact];
  const out = new Set<string>([exact]);
  for (const permutation of permute(segments)) out.add(permutation.join(""));
  return [...out];
}

function permute(items: string[]): string[][] {
  if (items.length <= 1) return [items];
  const out: string[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permute(rest)) out.push([items[i], ...tail]);
  }
  return out;
}
