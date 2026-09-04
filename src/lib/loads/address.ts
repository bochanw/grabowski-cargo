// Kod pocztowy JEST CZĘŚCIĄ ADRESU (właściciel: „kod pocztowy powinien być w adresie") — osobna
// kolumna w Zestawieniu pokazywała drugi raz to, co i tak stoi w adresie.
//
// W bazie `loads.postal_code` zostaje, bo od niego liczy się stawka dla kierowcy (cennik
// `driver_rates` dopasowuje po prefiksie) i bo szukają po nim filtry — ale przestaje być polem,
// które ktokolwiek wypełnia osobno: jest WYLICZANY z adresu. Dzięki temu to, co dyspozytor widzi
// w komórce, jest dokładnie tym, co appka wie: nie da się mieć w adresie jednego kodu, a w stawce
// drugiego.
//
// Kierunek odwrotny (kod jest, a adres go nie zawiera) zdarza się przy odczycie z dokumentu: model
// oddaje sam adres, a kod appka znajduje przy miejscowości w tekście (patrz postalFromText.ts).
// Wtedy komórka dopisuje go do adresu — nic nie ginie z oczu, a pierwszy zapis wpisuje kod do
// samego adresu.

import { extractPostalCode, formatPostalCode } from "@/lib/driverRates/rates";

/** Adres tak, jak ma stać w komórce i w edytorze: z kodem pocztowym, gdy ten nie jest już w treści. */
export function addressWithPostal(address: string | null | undefined, postal: string | null | undefined): string {
  const text = (address ?? "").trim();
  const code = formatPostalCode(postal ?? "").trim();
  if (!code) return text;
  if (!text) return code;
  // Adres, który już niesie JAKIŚ kod, zostaje bez zmian — dopisanie drugiego dałoby w jednej
  // linijce dwa kody i nie byłoby wiadomo, który obowiązuje.
  if (extractPostalCode(text)) return text;
  return `${text}, ${code}`;
}

/** Wpisany adres → pola zlecenia. Kod z tekstu jest jedyną prawdą; brak kodu w adresie = brak kodu. */
export function addressCellPatch(raw: string): { address: string | null; postal_code: string | null } {
  const text = raw.trim();
  const digits = extractPostalCode(text);
  return {
    address: text === "" ? null : text,
    postal_code: digits ? formatPostalCode(digits) : null,
  };
}
