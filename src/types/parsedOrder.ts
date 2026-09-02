// Wspólny kształt "pól wyciągniętych ze zlecenia PDF", niezależnie od METODY odczytu —
// deterministyczny parser znanego szablonu (src/lib/orderTemplates/) albo, docelowo, Edge Function
// odpytująca Claude dla nieznanych szablonów (supabase/functions/parse-order-pdf, na razie
// niepodłączona pod UI — patrz CLAUDE.md, "Import zleceń z PDF"). ImportOrderDialog nie wie/nie
// dba o to, które źródło dostarczyło dane — ten sam formularz podglądu/edycji dla obu.
export interface ParsedOrder {
  order_number: string;
  forwarder: string;
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
}

export const EMPTY_PARSED_ORDER: ParsedOrder = {
  order_number: "",
  forwarder: "",
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
};
