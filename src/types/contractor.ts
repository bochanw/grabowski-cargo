// Odwzorowanie public.contractors — patrz supabase/migrations/0004_contractors.sql.

/**
 * Jak wypchnąć BAF (dodatek paliwowy) na fakturę — właściciel: "będziemy wypychać do faktur albo
 * stawkę z BAF razem, albo BAF jako oddzielną pozycję na fakturze — do konfiguracji via klient".
 * Ustawienie jest więc PER KONTRAHENT, nie globalne. Domyślnie "razem" (jedna pozycja), bo tak
 * appka fakturowała do tej pory — zmiana ustawienia jest świadomą decyzją, nie skutkiem ubocznym.
 */
export type BafInvoiceMode = "combined" | "separate";

export const BAF_INVOICE_MODE_LABELS: Record<BafInvoiceMode, string> = {
  combined: "razem ze stawką (jedna pozycja)",
  separate: "osobna pozycja „BAF” na fakturze",
};

export interface Contractor {
  id: string;
  name: string;
  aliases: string[];
  nip: string | null;
  vat_eu: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  email: string | null;
  payment_terms_days: number | null;
  payment_terms_note: string | null;
  baf_invoice_mode: BafInvoiceMode;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ContractorInput = Omit<Contractor, "id" | "created_at" | "updated_at">;

export const EMPTY_CONTRACTOR: ContractorInput = {
  name: "",
  aliases: [],
  nip: null,
  vat_eu: null,
  address: null,
  postal_code: null,
  city: null,
  email: null,
  payment_terms_days: null,
  payment_terms_note: null,
  baf_invoice_mode: "combined",
  notes: null,
};

/** Wiersz zapisany PRZED migracją 0013 (albo ręcznie w SQL Editor) może nie mieć tego pola. */
export function bafInvoiceMode(contractor: Pick<Contractor, "baf_invoice_mode"> | null | undefined): BafInvoiceMode {
  return contractor?.baf_invoice_mode === "separate" ? "separate" : "combined";
}

// Dopasowanie nazwy spedytora z dokumentu do kontrahenta: bez wielkości liter, interpunkcji i
// dopisków formy prawnej — "Q4Road Sp. z o.o" == "Q4ROAD sp. z o.o." == "q4road".
export function normalizeContractorName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/\b(sp\.?\s*z\s*o\.?\s*o\.?|spółka z ograniczoną odpowiedzialnością|s\.?a\.?|sp\.?\s*k\.?|sp\.?\s*j\.?)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function findContractorByName(contractors: Contractor[], name: string): Contractor | null {
  const key = normalizeContractorName(name);
  if (!key) return null;
  return (
    contractors.find((c) => normalizeContractorName(c.name) === key || c.aliases.some((a) => normalizeContractorName(a) === key)) ??
    null
  );
}
