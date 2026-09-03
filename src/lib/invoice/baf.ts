// BAF (Bunker Adjustment Factor — dodatek paliwowy) rozbity na stawkę bazową i sam dodatek.
//
// Zgłoszenie właściciela po imporcie przez Claude: "w jednym zleceniu było, że stawka już jest z
// BAF 13% — wtedy program powinien, znając stawkę, rozdzielić, ile wynosi stawka bazowa, ile BAF".
// Rozbicie jest potrzebne do faktury: część kontrahentów chce jedną pozycję (stawka razem z BAF),
// część osobną pozycję "BAF" — o tym decyduje `contractors.baf_invoice_mode` (migracja 0013).
//
// Dwa kierunki liczenia, bo dokumenty podają stawkę na oba sposoby:
//   • stawka ZAWIERA BAF ("3 000 PLN, w tym BAF 13%") → baza = stawka / 1,13; BAF = stawka - baza
//   • BAF DOLICZANY do stawki ("2 000 PLN + BAF 13%")  → BAF = stawka × 13%; razem = stawka + BAF
// Zaokrąglamy do groszy, a BAF liczymy jako RÓŻNICĘ (nie osobnym mnożeniem), żeby pozycje faktury
// zawsze sumowały się dokładnie do kwoty, którą widzi dyspozytor — inaczej suma dwóch pozycji
// potrafi się rozjechać o grosz z kwotą uzgodnioną ze spedytorem.
export interface BafSplit {
  /** Stawka bazowa (fracht bez dodatku paliwowego). */
  base: number | null;
  /** Kwota dodatku paliwowego; null, gdy zlecenie nie ma BAF-u. */
  baf: number | null;
  /** Razem do zafakturowania (baza + BAF). */
  total: number | null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param rate            kwota z dokumentu/formularza
 * @param percentage      procent BAF (13 = 13%); null/0 = zlecenie bez BAF-u
 * @param rateIncludesBaf czy `rate` jest kwotą Z BAF-em (true) czy samą bazą (false)
 */
export function splitBaf(
  rate: number | null | undefined,
  percentage: number | null | undefined,
  rateIncludesBaf: boolean
): BafSplit {
  const amount = finite(rate);
  const percent = finite(percentage);
  if (amount === null) return { base: null, baf: null, total: null };
  if (percent === null || percent <= 0) return { base: amount, baf: null, total: amount };

  if (rateIncludesBaf) {
    const total = round2(amount);
    const base = round2(total / (1 + percent / 100));
    return { base, baf: round2(total - base), total };
  }
  const base = round2(amount);
  const total = round2(base * (1 + percent / 100));
  return { base, baf: round2(total - base), total };
}

/**
 * Opis rozbicia do pokazania dyspozytorowi — jedno zdanie pod polem stawki. Pusty string dla
 * zlecenia bez BAF-u: sama stawka stoi już w polu obok, więc zdanie "bez BAF-u" byłoby szumem.
 */
export function describeBafSplit(split: BafSplit, percentage: number | null | undefined): string {
  if (split.base === null || split.baf === null || split.total === null) return "";
  const money = (value: number) => value.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Stawka bazowa ${money(split.base)} PLN + BAF ${percentage}% (${money(split.baf)} PLN) = razem ${money(split.total)} PLN.`;
}
