// Reguły, które appka dokłada do KAŻDEGO odczytanego zlecenia — niezależnie od tego, skąd pola
// przyszły (znany szablon, nauczony szablon, Claude, Skrzynka, ręczne wpisanie).
//
// Powstało po regresji: właściciel zgłosił „przestałeś automatycznie uzupełniać datę (domyślnie
// dzień roboczy przed rozładunkiem)". Przyczyna była w rozdzielaniu maila na zlecenia — `mail-poll`
// dolicza domyślną datę tylko do pól SCALONYCH przy mailu, a od kiedy okno bierze pola PER
// ZAŁĄCZNIK (żeby rozdzielić kilka zleceń z jednego maila), tamta data w ogóle nie dochodziła.
// Wniosek na przyszłość: reguła „appka to sobie dolicza" nie może siedzieć w jednej z dróg odczytu,
// bo dołożenie drugiej drogi cicho ją gubi. Stąd JEDNO miejsce, wołane przy każdym wejściu pól do
// formularza.

import { previousWorkingDay } from "@/lib/dates/workingDays";
import { canOverwriteGrossWeight, computeGrossWeightKg } from "@/lib/containers/tare";
import { shippingLineForNotes } from "@/lib/loads/leasing";
import { extractPostalCode, formatPostalCode } from "@/lib/driverRates/rates";
import { addressWithPostal } from "@/lib/loads/address";
import type { ParsedOrder } from "@/types/parsedOrder";

export interface OrderDefaults {
  order: ParsedOrder;
  /** Co appka zmieniła sama — do pokazania w oknie, żeby nie działo się to w ukryciu. */
  warnings: string[];
}

export function applyOrderDefaults(order: ParsedOrder): OrderDefaults {
  const warnings: string[] = [];
  let next = order;

  // Domyślna „Data" = dzień roboczy przed rozładunkiem/załadunkiem z dokumentu (decyzja właściciela:
  // „docelowo będzie to poprzedni dzień roboczy poprzedzający rozładunek/załadunek"). Tylko gdy
  // pole jest puste — data wpisana ręcznie albo z dokumentu wygrywa.
  if (!next.load_date && next.delivery_date) {
    next = { ...next, load_date: previousWorkingDay(next.delivery_date) };
  }

  // Brutto = waga towaru + tara kontenera. Liczone po scaleniu dokumentów, bo typ kontenera bywa
  // w jednym dokumencie, a waga towaru w drugim. Ręczny tekst („według armatora") zostaje.
  const gross = computeGrossWeightKg(next.net_weight_kg, next.container_size);
  if (gross !== null && canOverwriteGrossWeight(next.gross_weight)) {
    next = { ...next, gross_weight: String(gross) };
  }

  // Ważenie: dokumenty prawie nigdy nie piszą "ważenie: wymagane" — piszą, GDZIE się waży
  // ("ważenie w porcie", "waga miejska Gdynia"). Skoro dokument wskazał miejsce, to znaczy, że
  // ważenie jest. Odwrotnie NIE działa: brak miejsca nie znaczy "niewymagane", więc pola „czy"
  // wtedy nie ruszamy — zostaje null („dokument o tym nie mówi"). Świadome "nie" dyspozytora
  // (false) też zostaje nietknięte.
  if (next.weighing_place && next.weighing_required === null) {
    warnings.push(`Dokument podaje miejsce ważenia („${next.weighing_place}”) — zaznaczono, że ważenie jest wymagane.`);
    next = { ...next, weighing_required: true };
  }

  // Gestia z uwag: kontener leasingowy nie ma armatora, a informacja o leasingu stoi w uwagach.
  const line = shippingLineForNotes(next.notes, next.shipping_line) ?? "";
  if (line !== next.shipping_line) {
    warnings.push(
      next.shipping_line
        ? `Uwagi wspominają o leasingu — gestię przestawiono z "${next.shipping_line}" na "Leasing".`
        : "Uwagi wspominają o leasingu — gestię ustawiono na „Leasing”."
    );
    next = { ...next, shipping_line: line };
  }

  // Kod pocztowy z adresu: dokumenty rzadko mają osobną rubrykę, a adres bywa jednym ciągiem
  // ("Słoneczna 42 A, 05-500 Piaseczno"). Od kodu zależy stawka dla kierowcy, więc wyłuskujemy go
  // raz i zapisujemy przy zleceniu — inaczej ta sama regułka musiałaby stać w każdym miejscu,
  // które stawkę liczy (a to jest dokładnie ten błąd, po którym powstał ten plik).
  if (!next.postal_code) {
    const fromAddress = extractPostalCode([next.address, next.city].filter(Boolean).join(" "));
    if (fromAddress) next = { ...next, postal_code: formatPostalCode(fromAddress) };
  }

  // …a gdy kod przyszedł Z DOKUMENTU (model albo szukanie przy miejscowości), a w adresie go nie ma
  // — dopisujemy go do adresu. Właściciel: „kod pocztowy powinien być w adresie", więc kod nie ma
  // już własnego pola ani kolumny: to, co widać w adresie, jest tym, po czym liczy się stawka.
  if (next.postal_code) {
    const withCode = addressWithPostal(next.address, next.postal_code);
    if (withCode !== next.address) next = { ...next, address: withCode };
  }

  // Stawki dla kierowcy TU NIE MA i to jest świadome: cennik przychodzi z bazy (asynchronicznie),
  // a ta funkcja bywa wołana w inicjalizatorze stanu okna — czyli czasem ZANIM cennik dojedzie.
  // Reguła siedzi więc w jednym miejscu innego rodzaju: `computeDriverRate` (czysty odczyt cennika),
  // wołane na żywo przez okno zlecenia (podpowiedź w formularzu), edycję inline w tabeli
  // i przeliczanie zbiorcze. Patrz src/lib/driverRates/.

  return { order: next, warnings };
}
