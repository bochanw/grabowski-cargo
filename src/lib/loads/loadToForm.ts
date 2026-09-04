import { normalizeStops } from "@/types/loadStop";
import type { ParsedOrder } from "@/types/parsedOrder";
import type { Load } from "@/types/load";

/**
 * Zapisane zlecenie → pola formularza (kształt `ParsedOrder`).
 *
 * Trzy miejsca potrzebują dokładnie tego samego przeliczenia: okno zlecenia (import, „Dopnij PDF",
 * uzupełnianie rozpoznanego zlecenia) ORAZ nauka szablonów z dokumentów już leżących przy zleceniu
 * (`fromStored.ts`) — tam „to, co zatwierdził dyspozytor" to po prostu zapisany rekord. Dlatego
 * funkcja stoi tutaj, a nie w komponencie okna.
 */
export function loadToForm(load: Load): ParsedOrder {
  return {
    order_number: load.order_number ?? "",
    forwarder: load.forwarder ?? "",
    // Dane spedytora nie są trzymane na zleceniu (żyją w contractors) — przy edycji/dopięciu puste.
    forwarder_nip: "",
    forwarder_address: "",
    forwarder_postal_code: "",
    forwarder_city: "",
    direction: load.direction,
    container_number: load.container_number ?? "",
    container_size: load.container_size ?? "",
    shipping_line: load.shipping_line ?? "",
    company_name: load.company_name ?? "",
    address: load.address ?? "",
    city: load.city ?? "",
    postal_code: load.postal_code ?? "",
    contact_phone: load.contact_phone ?? "",
    extra_stops: normalizeStops(load.stops),
    load_date: load.load_date ?? "",
    delivery_date: load.secondary_date ?? "",
    delivery_time: load.time_of_day ?? "",
    customs_location_or_status: load.customs_status ?? "",
    // Stawka w formularzu to kwota RAZEM (baza + BAF) — z rozbicia zapisanego przy zleceniu wraca
    // dokładnie ta sama liczba, którą podał dokument, a formToRow rozbije ją z powrotem.
    rate_amount: load.total_amount ?? load.invoice_amount,
    rate_currency: "",
    baf_percentage: load.baf_percentage,
    rate_includes_baf: load.baf_amount === null ? null : true,
    payment_terms_days: load.payment_terms_days,
    payment_terms_note: load.payment_terms_note ?? "",
    notes: load.notes ?? "",
    pickup_type: load.pickup_type ?? "",
    pin_booking: load.pin_booking ?? "",
    seal_number: load.seal_number ?? "",
    goods_name: load.goods_name ?? "",
    adr_sent: load.adr_flag ?? "",
    weighing_required: load.weighing_required,
    weighing_place: load.weighing_export ?? "",
    net_weight_kg: load.net_weight_kg,
    gross_weight: load.gross_weight ?? "",
    submitted_when: load.submitted_when ?? "",
    submitted_where: load.submitted_where ?? "",
    driver_name: load.driver_name ?? "",
    driver_id_number: load.driver_id_number ?? "",
    vehicle_plate: load.vehicle_plate ?? "",
    trailer_plate: load.trailer_plate ?? "",
    driver_phone: load.driver_phone ?? "",
    driver_rate: load.driver_rate,
  };
}
