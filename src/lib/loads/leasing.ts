// Reguła właściciela: "jeżeli w uwagach będzie Leasing, to wtedy gestia przestaw na Leasing".
//
// Gestia (`shipping_line`) to normalnie armator/linia żeglugowa z dokumentu (ONE, MSC, Maersk).
// Kontener leasingowy nie ma armatora w tym sensie — u klienta zapisuje się to w gestii wprost jako
// "Leasing", a informacja o leasingu przychodzi w UWAGACH zlecenia. Stąd reguła po stronie appki, a
// nie w prompcie modelu: działa tak samo przy odczycie przez Claude, przy szablonie znanego
// spedytora, przy imporcie z maila i przy ręcznym wpisaniu uwag w tabeli.
//
// Świadomie NADPISUJE gestię ("przestaw"), ale tylko gdy uwagi faktycznie mówią o leasingu —
// dyspozytor może potem wpisać w gestię co chce, dopóki nie zmieni uwag.
export const LEASING_SHIPPING_LINE = "Leasing";

export function notesMentionLeasing(notes: string | null | undefined): boolean {
  return /leasing/i.test(notes ?? "");
}

/** Gestia po zastosowaniu reguły — zwraca wartość dotychczasową, jeśli reguła nie ma zastosowania. */
export function shippingLineForNotes(
  notes: string | null | undefined,
  currentShippingLine: string | null | undefined
): string | null {
  if (notesMentionLeasing(notes)) return LEASING_SHIPPING_LINE;
  return currentShippingLine ?? null;
}
