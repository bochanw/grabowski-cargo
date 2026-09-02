// Wspólny kształt "pól wyciągniętych z dokumentów zlecenia", niezależnie od METODY odczytu —
// deterministyczne parsery znanych szablonów (src/lib/orderTemplates/) albo, docelowo, Edge
// Function odpytująca Claude dla nieznanych szablonów (supabase/functions/parse-order-pdf, na razie
// niepodłączona pod UI — patrz CLAUDE.md, "Import zleceń z PDF"). ImportOrderDialog nie wie/nie
// dba o to, które źródło dostarczyło dane — ten sam formularz podglądu/edycji.
//
// Jedno zlecenie u klienta to zwykle DWA dokumenty (zlecenie spedycyjne + list przewozowy dla
// kierowcy) — każdy parser wypełnia tylko to, co ma, a `mergeParsedOrders` skleja je w jeden rekord.
export interface ParsedOrder {
  order_number: string;
  forwarder: string;
  // Dane spedytora z nagłówka zlecenia — do automatycznego założenia kontrahenta przy pierwszym
  // imporcie (właściciel: kontrahent ma się pojawić sam po wgraniu zlecenia, nie ręcznie).
  forwarder_nip: string;
  forwarder_address: string;
  forwarder_postal_code: string;
  forwarder_city: string;
  direction: "" | "I" | "E";
  container_number: string;
  container_size: string;
  shipping_line: string;
  company_name: string;
  address: string;
  city: string;
  load_date: string;
  delivery_date: string;
  delivery_time: string;
  customs_location_or_status: string;
  rate_amount: number | null;
  rate_currency: string;
  payment_terms_days: number | null;
  payment_terms_note: string;
  notes: string;
  // Z listu przewozowego (dokument dla kierowcy):
  pickup_type: string; // miejsce podjęcia kontenera — jedno z PICKUP_LOCATIONS (GCT/BCT/BHub)
  pin_booking: string; // numer wizyty / PIN albo booking
  goods_name: string;
  net_weight_kg: number | null; // waga towaru z dokumentu ("Waga towaru brutto" na liście przewozowym)
  gross_weight: string; // wyliczane: net_weight_kg + tara kontenera (src/lib/containers/tare.ts); text, bo bywa "według armatora"
  submitted_where: string; // miejsce złożenia pustego
  driver_name: string;
  driver_id_number: string;
  vehicle_plate: string;
  trailer_plate: string;
  driver_phone: string;
}

export const EMPTY_PARSED_ORDER: ParsedOrder = {
  order_number: "",
  forwarder: "",
  forwarder_nip: "",
  forwarder_address: "",
  forwarder_postal_code: "",
  forwarder_city: "",
  direction: "",
  container_number: "",
  container_size: "",
  shipping_line: "",
  company_name: "",
  address: "",
  city: "",
  load_date: "",
  delivery_date: "",
  delivery_time: "",
  customs_location_or_status: "",
  rate_amount: null,
  rate_currency: "",
  payment_terms_days: null,
  payment_terms_note: "",
  notes: "",
  pickup_type: "",
  pin_booking: "",
  goods_name: "",
  net_weight_kg: null,
  gross_weight: "",
  submitted_where: "",
  driver_name: "",
  driver_id_number: "",
  vehicle_plate: "",
  trailer_plate: "",
  driver_phone: "",
};

function isEmpty(value: string | number | null): boolean {
  return value === null || value === "";
}

/**
 * Skleja pola z kolejnego dokumentu w istniejący rekord: wypełnia TYLKO puste pola, nigdy nie
 * nadpisuje tego, co już jest (w tym ręcznych poprawek dyspozytora). Kolejność wgrywania
 * dokumentów nie ma więc znaczenia dla pól, które występują tylko w jednym z nich.
 */
export function mergeParsedOrders(base: ParsedOrder, incoming: ParsedOrder): ParsedOrder {
  const merged = { ...base };
  for (const key of Object.keys(incoming) as (keyof ParsedOrder)[]) {
    if (isEmpty(merged[key] as string | number | null) && !isEmpty(incoming[key] as string | number | null)) {
      (merged as Record<keyof ParsedOrder, ParsedOrder[keyof ParsedOrder]>)[key] = incoming[key];
    }
  }
  return merged;
}
