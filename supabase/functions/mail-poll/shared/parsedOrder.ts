// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/types/parsedOrder.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

// Wspólny kształt "pól wyciągniętych z dokumentów zlecenia", niezależnie od METODY odczytu —
// deterministyczne parsery znanych szablonów (src/lib/orderTemplates/) albo Edge Function
// odpytująca Claude dla nieznanych szablonów (supabase/functions/parse-order-pdf — fallback, patrz
// CLAUDE.md, "Import zleceń z PDF"). ImportOrderDialog nie wie/nie dba o to, które źródło
// dostarczyło dane — ten sam formularz podglądu/edycji.
//
// Jedno zlecenie u klienta to zwykle DWA dokumenty (zlecenie spedycyjne + list przewozowy dla
// kierowcy) — każdy parser wypełnia tylko to, co ma, a `mergeParsedOrders` skleja je w jeden rekord.
import { matchPickupLocation, normalizeTerminalName } from "./pickupLocations.ts";

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
  // Dodatek paliwowy (BAF). Dokumenty podają stawkę na dwa sposoby — "2 000 + BAF 13%" albo
  // "3 000, w tym BAF 13%" — a różnica decyduje o kwocie bazowej, więc jest osobnym polem, nie
  // domysłem: `rate_includes_baf === null` znaczy "dokument nie mówi" (appka liczy wtedy jak przy
  // BAF-ie doliczanym). Rozbicie liczy src/lib/invoice/baf.ts.
  baf_percentage: number | null;
  rate_includes_baf: boolean | null;
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
  baf_percentage: null,
  rate_includes_baf: null,
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

// `false` (np. "stawka NIE zawiera BAF-u") jest wartością, nie brakiem — puste jest tylko null i "".
function isEmpty(value: string | number | boolean | null): boolean {
  return value === null || value === "";
}

/**
 * Doprowadza LUŹNY obiekt (odpowiedź modelu z Edge Function) do pełnego kształtu ParsedOrder:
 * brakujące klucze dostają wartości z EMPTY_PARSED_ORDER, a typy są wymuszane (model potrafi
 * zwrócić liczbę jako string albo string jako null). Bez tego `mergeParsedOrders` wpisałby
 * `undefined` w pole formularza (isEmpty(undefined) === false), co zamienia inputa w
 * niekontrolowany i wysypuje Reacta — dlatego KAŻDE źródło spoza własnych parserów przechodzi tędy.
 */
export function normalizeParsedOrder(raw: unknown): ParsedOrder {
  const input = (raw ?? {}) as Record<string, unknown>;
  const text = (key: keyof ParsedOrder): string => {
    const value = input[key];
    return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  };
  const num = (key: keyof ParsedOrder): number | null => {
    const value = input[key];
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
      return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  // Model bywa zwraca "tak"/"true"/1 zamiast boolean — a brak klucza MUSI zostać nullem
  // ("dokument nie mówi"), nie fałszem, bo false znaczy "stawka NIE zawiera BAF-u".
  const bool = (key: keyof ParsedOrder): boolean | null => {
    const value = input[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "tak", "yes", "1"].includes(normalized)) return true;
      if (["false", "nie", "no", "0"].includes(normalized)) return false;
    }
    return null;
  };

  const direction = text("direction").toUpperCase();
  return {
    ...EMPTY_PARSED_ORDER,
    order_number: text("order_number"),
    forwarder: text("forwarder"),
    forwarder_nip: text("forwarder_nip"),
    forwarder_address: text("forwarder_address"),
    forwarder_postal_code: text("forwarder_postal_code"),
    forwarder_city: text("forwarder_city"),
    direction: direction === "I" || direction === "E" ? direction : "",
    container_number: text("container_number"),
    container_size: text("container_size"),
    shipping_line: text("shipping_line"),
    company_name: text("company_name"),
    address: text("address"),
    city: text("city"),
    load_date: text("load_date"),
    delivery_date: text("delivery_date"),
    delivery_time: text("delivery_time"),
    customs_location_or_status: text("customs_location_or_status"),
    rate_amount: num("rate_amount"),
    rate_currency: text("rate_currency"),
    baf_percentage: num("baf_percentage"),
    rate_includes_baf: bool("rate_includes_baf"),
    payment_terms_days: num("payment_terms_days"),
    payment_terms_note: text("payment_terms_note"),
    notes: text("notes"),
    pickup_type: matchPickupLocation(text("pickup_type")) || text("pickup_type"),
    pin_booking: text("pin_booking"),
    goods_name: text("goods_name"),
    net_weight_kg: num("net_weight_kg"),
    gross_weight: text("gross_weight"),
    // Terminale bywają w dokumentach pełną nazwą ("Gdynia Container Terminal" = GCT — zgłoszenie
    // właściciela po imporcie przez Claude). Podjęcie sprowadzamy do listy rozwijanej, ale gdy nic
    // nie pasuje, ZOSTAWIAMY tekst z dokumentu — wcześniej nierozpoznana wartość znikała bez śladu
    // (formularz i tak pokaże ją jako dodatkową opcję). Miejsce zdania kontenera bywa zwykłym
    // adresem, więc skracamy je tylko wtedy, gdy CAŁA wartość jest nazwą terminala.
    submitted_where: normalizeTerminalName(text("submitted_where")),
    driver_name: text("driver_name"),
    driver_id_number: text("driver_id_number"),
    vehicle_plate: text("vehicle_plate"),
    trailer_plate: text("trailer_plate"),
    driver_phone: text("driver_phone"),
  };
}

/**
 * Skleja pola z kolejnego dokumentu w istniejący rekord: wypełnia TYLKO puste pola, nigdy nie
 * nadpisuje tego, co już jest (w tym ręcznych poprawek dyspozytora). Kolejność wgrywania
 * dokumentów nie ma więc znaczenia dla pól, które występują tylko w jednym z nich.
 */
export function mergeParsedOrders(base: ParsedOrder, incoming: ParsedOrder): ParsedOrder {
  const merged = { ...base };
  for (const key of Object.keys(incoming) as (keyof ParsedOrder)[]) {
    if (isEmpty(merged[key] as string | number | boolean | null) && !isEmpty(incoming[key] as string | number | boolean | null)) {
      (merged as Record<keyof ParsedOrder, ParsedOrder[keyof ParsedOrder]>)[key] = incoming[key];
    }
  }
  return merged;
}
