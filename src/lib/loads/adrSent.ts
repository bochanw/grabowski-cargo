// ADR / SENT — oznaczenia ładunku, które dyspozytor zaznacza przy zleceniu (właściciel: „zaznaczenia
// SENT bądź ADR (bądź oba)").
//
// W bazie jest to JEDNA kolumna tekstowa `loads.adr_flag` (tak jest w arkuszu klienta i tak
// nazywają to w firmie — „adr/sent"), a nie dwie kolumny logiczne. Dlatego formularz pokazuje dwa
// checkboxy, a tutaj siedzi tłumaczenie w obie strony.
//
// Reguła, na której zależy najbardziej: **wartość spoza tych dwóch słów nie może zginąć**. W arkuszu
// bywa tam dopisek („ADR kl. 3", „SENT — zgłoszenie klienta"), a odhaczenie checkboxa nie może
// skasować informacji, której nikt nie wpisał po to, żeby ją stracić.

export interface AdrSent {
  adr: boolean;
  sent: boolean;
}

const ADR = /\bADR\b/i;
const SENT = /\bSENT\b/i;

export function parseAdrSent(raw: string | null | undefined): AdrSent {
  const value = raw ?? "";
  return { adr: ADR.test(value), sent: SENT.test(value) };
}

/** Co zostaje z wartości po wyjęciu samych słów ADR/SENT — dopisek, który ma przetrwać przełączanie. */
export function adrSentRemainder(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(new RegExp(ADR.source, "gi"), " ")
    .replace(new RegExp(SENT.source, "gi"), " ")
    // Separatory osierocone po wyjęciu słów ("ADR + SENT — kl. 3" → "— kl. 3" → "kl. 3").
    .replace(/^[\s+,/;–—-]+/, "")
    .replace(/[\s+,/;–—-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Nowa wartość kolumny po przestawieniu checkboxów — z zachowanym dopiskiem z dokumentu. */
export function withAdrSent(raw: string | null | undefined, next: AdrSent): string {
  const flags = [next.adr ? "ADR" : "", next.sent ? "SENT" : ""].filter(Boolean).join(" + ");
  const rest = adrSentRemainder(raw);
  if (!flags) return rest;
  return rest ? `${flags} — ${rest}` : flags;
}
