// Odwzorowanie public.contractors — patrz supabase/migrations/0004_contractors.sql.
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
  notes: null,
};

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
