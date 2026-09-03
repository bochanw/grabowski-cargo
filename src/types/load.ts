// Odwzorowanie tabeli public.loads — patrz supabase/migrations/0001_loads_schema_rls.sql
// dla mapowania na oryginalne kolumny arkusza klienta (litery Excela w komentarzach SQL).
export type Direction = "I" | "E";

export interface Load {
  id: string;
  load_date: string | null;
  pickup_type: string | null;
  city: string | null;
  order_number: string | null;
  forwarder: string | null;
  container_number: string | null;
  shipping_line: string | null;
  company_name: string | null;
  address: string | null;
  contact_phone: string | null;
  customs_status: string | null;
  notes: string | null;
  container_size: string | null;
  direction: Direction;
  secondary_date: string | null;
  time_of_day: string | null;
  weighing_export: string | null;
  goods_name: string | null;
  status: string | null;
  pin_booking: string | null;
  seal_number: string | null; // migracja 0014 — numer plomby
  reference_number: string | null;
  net_weight_kg: number | null;
  gross_weight: string | null;
  driver_rate: string | null;
  submitted_when: string | null;
  submitted_where: string | null;
  driver_initials: string | null;
  driver_name: string | null;
  driver_id_number: string | null;
  vehicle_plate: string | null;
  trailer_plate: string | null;
  driver_phone: string | null;

  carrier_name: string | null;
  documents_received_date: string | null;
  subcontractor_rate: number | null;
  subcontractor_invoice_number: string | null;
  subcontractor_net_amount: number | null;
  subcontractor_payment_due_date: string | null;
  subcontractor_paid: string | null;
  gct_invoice_number: string | null;
  rebilling_comment: string | null;
  settled_weight_kg: number | null;
  delivery_or_customs: string | null;
  rate_misc: string | null;
  adr_flag: string | null;
  gct_leasing_addons: number | null;
  freight_base_amount: number | null; // migracja 0013 — stawka bazowa (fracht bez BAF-u)
  baf_percentage: number | null;
  baf_amount: number | null;
  total_amount: number | null;

  invoice_number: string | null;
  invoice_amount: number | null;
  invoice_payment_date: string | null;
  invoice_code: string | null;
  payment_terms_days: number | null;
  payment_terms_note: string | null;
  contractor_id: string | null; // public.contractors — dane do faktury, patrz migracja 0004
  fakturownia_invoice_id: number | null; // migracja 0005 — ustawione = faktura już wystawiona
  invoice_url: string | null;
  invoice_issued_at: string | null;

  correct_data_flag: string | null;
  loading_number: string | null;
  wants_own_cmr: string | null;

  created_at: string;
  updated_at: string;
}
