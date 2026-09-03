import type { Load } from "@/types/load";

// Trzy bloki odzwierciedlają trzy sklejone boki arkusza klienta (patrz
// CLAUDE.md): dane ładunku, rozliczenie z podwykonawcą, fakturowanie — plus
// garść dalekich, rzadkich kolumn ("inne"). `ladunek` jest zawsze widoczny,
// pozostałe bloki są zwijane w UI, żeby 60 kolumn nie stało się ścianą.
export type ColumnBlock = "ladunek" | "rozliczenie" | "fakturowanie" | "inne";

export interface ColumnDef {
  key: keyof Load;
  label: string;
  block: ColumnBlock;
  align?: "right";
  // "contractor": wartość to id z public.contractors, wyświetlana/edytowana przez nazwę.
  kind?: "number" | "date" | "contractor";
}

export const COLUMNS: ColumnDef[] = [
  { key: "load_date", label: "Data", block: "ladunek", kind: "date" },
  { key: "pickup_type", label: "Podjęcie", block: "ladunek" },
  { key: "city", label: "Miejscowość", block: "ladunek" },
  { key: "order_number", label: "Nr zlecenia", block: "ladunek" },
  { key: "forwarder", label: "Spedycja", block: "ladunek" },
  { key: "container_number", label: "Nr kontenera", block: "ladunek" },
  { key: "shipping_line", label: "Gestia", block: "ladunek" },
  { key: "company_name", label: "Dane firmy", block: "ladunek" },
  { key: "address", label: "Adres", block: "ladunek" },
  { key: "contact_phone", label: "Telefon", block: "ladunek" },
  { key: "customs_status", label: "Odprawa", block: "ladunek" },
  { key: "notes", label: "Uwagi", block: "ladunek" },
  { key: "container_size", label: "Wielkość", block: "ladunek" },
  { key: "secondary_date", label: "Data (2)", block: "ladunek", kind: "date" },
  { key: "time_of_day", label: "Godz.", block: "ladunek" },
  { key: "weighing_export", label: "Ważenie (export)", block: "ladunek" },
  { key: "goods_name", label: "Nazwa towaru", block: "ladunek" },
  { key: "status", label: "Status", block: "ladunek" },
  { key: "pin_booking", label: "PIN/booking", block: "ladunek" },
  { key: "reference_number", label: "Nr ref.", block: "ladunek" },
  { key: "net_weight_kg", label: "Waga netto", block: "ladunek", align: "right", kind: "number" },
  { key: "gross_weight", label: "Waga brutto", block: "ladunek" },
  { key: "driver_rate", label: "Stawka kierowcy", block: "ladunek" },
  { key: "submitted_when", label: "Złożone kiedy", block: "ladunek" },
  { key: "submitted_where", label: "Złożenie gdzie", block: "ladunek" },
  { key: "driver_initials", label: "Inicjały kierowcy", block: "ladunek" },
  { key: "driver_name", label: "Kierowca", block: "ladunek" },
  { key: "driver_id_number", label: "Nr dowodu", block: "ladunek" },
  { key: "vehicle_plate", label: "Pojazd", block: "ladunek" },
  { key: "trailer_plate", label: "Naczepa", block: "ladunek" },
  { key: "driver_phone", label: "Telefon kierowcy", block: "ladunek" },

  { key: "carrier_name", label: "Przewoźnik", block: "rozliczenie" },
  { key: "documents_received_date", label: "Dokumenty otrzymano", block: "rozliczenie", kind: "date" },
  { key: "subcontractor_rate", label: "Stawka podwykonawcy", block: "rozliczenie", align: "right", kind: "number" },
  { key: "subcontractor_invoice_number", label: "Nr faktury podwyk.", block: "rozliczenie" },
  { key: "subcontractor_net_amount", label: "Kwota netto", block: "rozliczenie", align: "right", kind: "number" },
  { key: "subcontractor_payment_due_date", label: "Termin płatności", block: "rozliczenie", kind: "date" },
  { key: "subcontractor_paid", label: "Zapłacono", block: "rozliczenie" },
  { key: "gct_invoice_number", label: "Nr faktury GCT", block: "rozliczenie" },
  { key: "rebilling_comment", label: "Refaktura/komentarz", block: "rozliczenie" },
  { key: "settled_weight_kg", label: "Waga (rozl.)", block: "rozliczenie", align: "right", kind: "number" },
  { key: "delivery_or_customs", label: "Dostawa/odprawa", block: "rozliczenie" },
  { key: "rate_misc", label: "Stawka (inne)", block: "rozliczenie" },
  { key: "adr_flag", label: "ADR", block: "rozliczenie" },
  { key: "gct_leasing_addons", label: "GCT leasing dodatki", block: "rozliczenie", align: "right", kind: "number" },
  { key: "freight_base_amount", label: "Stawka bazowa", block: "rozliczenie", align: "right", kind: "number" },
  { key: "baf_percentage", label: "%BAF", block: "rozliczenie", align: "right", kind: "number" },
  { key: "baf_amount", label: "Kwota BAF", block: "rozliczenie", align: "right", kind: "number" },
  { key: "total_amount", label: "SUMA", block: "rozliczenie", align: "right", kind: "number" },

  { key: "contractor_id", label: "Kontrahent", block: "fakturowanie", kind: "contractor" },
  { key: "invoice_number", label: "Nr faktury", block: "fakturowanie" },
  { key: "invoice_amount", label: "Kwota", block: "fakturowanie", align: "right", kind: "number" },
  { key: "invoice_issued_at", label: "Wystawiono", block: "fakturowanie", kind: "date" },
  { key: "invoice_payment_date", label: "Data płatności", block: "fakturowanie", kind: "date" },
  { key: "invoice_code", label: "KOD", block: "fakturowanie" },
  { key: "payment_terms_days", label: "Termin płatności (dni)", block: "fakturowanie", align: "right", kind: "number" },
  { key: "payment_terms_note", label: "Warunek płatności", block: "fakturowanie" },

  { key: "correct_data_flag", label: "Poprawne dane", block: "inne" },
  { key: "loading_number", label: "Nr załad.", block: "inne" },
  { key: "wants_own_cmr", label: "Kto chce swój list", block: "inne" },
];

export const BLOCK_LABELS: Record<ColumnBlock, string> = {
  ladunek: "Ładunek",
  rozliczenie: "Rozliczenie z podwykonawcą",
  fakturowanie: "Fakturowanie",
  inne: "Inne",
};
