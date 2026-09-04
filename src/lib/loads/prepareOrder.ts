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

  return { order: next, warnings };
}
