import type { LoadStop } from "./loadStop";

// Odwzorowanie tabeli public.loads — patrz supabase/migrations/0001_loads_schema_rls.sql
// dla mapowania na oryginalne kolumny arkusza klienta (litery Excela w komentarzach SQL).
// I = import, E = eksport, K = krajówka (migracja 0026). Krajówka liczy się do eksportów, ale ma
// w Zestawieniu własny blok STOJĄCY NAD nimi — reguły „co znaczy który kierunek" siedzą w jednym
// miejscu: src/lib/loads/direction.ts (m.in. `isExportSide`).
export type Direction = "I" | "E" | "K";

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
  /**
   * KOLEJNE (2., 3., …) miejsca załadunku/rozładunku — migracja 0027. Pierwsze miejsce siedzi
   * w `company_name`/`address`/`city`/`secondary_date`/`time_of_day`, patrz src/types/loadStop.ts.
   */
  stops: LoadStop[];
  contact_phone: string | null;
  customs_status: string | null;
  notes: string | null;
  container_size: string | null;
  direction: Direction;
  secondary_date: string | null;
  time_of_day: string | null;
  // Ważenie kontenera — migracja 0029. `weighing_required`: true = wymagane, false = wprost
  // niewymagane, null = dokument o tym nie mówi. `weighing_export` (kolumna R arkusza) trzyma
  // MIEJSCE ważenia; nazwa jest historyczna („tylko export"), pole dotyczy obu kierunków.
  weighing_required: boolean | null;
  weighing_export: string | null;
  goods_name: string | null;
  status: string | null;
  pin_booking: string | null;
  seal_number: string | null; // migracja 0014 — numer plomby
  reference_number: string | null;
  net_weight_kg: number | null;
  gross_weight: string | null;
  /**
   * Kod pocztowy miejsca dostawy (import) / załadunku (eksport, krajówka) — migracja 0030.
   * Decyduje o stawce dla kierowcy, patrz src/lib/driverRates/rates.ts.
   */
  postal_code: string | null;
  /**
   * Stawka dla kierowcy w złotych (kolumna Y arkusza). Od migracji 0030 LICZBA, nie tekst
   * "[500 zł]": miesięczne zestawienie stawek musi ją sumować. `driver_rate_code` mówi, z którego
   * wiersza cennika wyszła, a `driver_rate_source` — czy wolno ją appce przeliczyć ('auto') czy
   * wpisał ją człowiek ('manual', nigdy nie nadpisujemy).
   */
  driver_rate: number | null;
  driver_rate_code: string | null;
  driver_rate_source: "auto" | "manual" | null;
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

  // Status kontenera z Baltic Hub — migracja 0016. Surowy zapis tego, co powiedział terminal;
  // porównania (ISO ↔ wielkość, armator ↔ gestia) liczy appka przy wyświetlaniu.
  bhub_status: string | null; // SS / ZS / SO / SP / ZP
  bhub_status_raw: string | null;
  bhub_iso_type: string | null;
  bhub_shipping_line: string | null;
  bhub_gross_weight_kg: number | null; // Weight [KG] = VGM, czyli brutto
  // Migracja 0031. Cargo Weight = waga towaru (u nas "netto"), Commodity = waga celna; różnica
  // między nimi to ostrzeżenie. "Time Out": PUSTY TEKST = rubryka jest i jest pusta (kontener
  // stoi), null = nie odczytano — z braku wiedzy nie wolno robić alarmu.
  bhub_net_weight_kg: number | null;
  bhub_commodity_weight_kg: number | null;
  bhub_time_out: string | null;
  bhub_checked_at: string | null;
  bhub_error: string | null;
  bhub_details: Record<string, unknown> | null;

  // Plan wspaniały — migracja 0025. Miejsce na zestawie; kontener 40/45 zajmuje oba i jest
  // zapisywany jako "tyl" (o zajęciu całości decyduje `container_size`, nie osobna wartość).
  plan_slot: "tyl" | "przod" | null;
  // Ręczne nadpisanie linii "po jakim imporcie" w kafelku eksportu. Puste = appka wylicza z planu.
  plan_prev_note: string | null;

  correct_data_flag: string | null;
  loading_number: string | null;
  wants_own_cmr: string | null;

  created_at: string;
  updated_at: string;
}
