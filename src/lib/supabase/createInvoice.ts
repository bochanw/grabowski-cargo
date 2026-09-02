import { supabase } from "./client";

export interface InvoicePositionRequest {
  title: string;
  amountNet: number;
}

export interface CreateInvoiceRequest {
  loadIds: string[];
  positions: InvoicePositionRequest[];
  currency?: string;
  paymentTermsDays: number | null;
  paymentTermsNote: string | null;
  sellDate: string | null;
  buyer: { name: string; nip: string | null; vatEu: string | null; street: string | null; email: string | null };
}

export interface CreatedInvoice {
  id: number;
  number: string;
  issueDate: string;
  paymentTo: string | null;
  viewUrl: string;
}

export type CreateInvoiceResult = { ok: true; invoice: CreatedInvoice } | { ok: false; reason: string; error: string };

/** Woła Edge Function `fakturownia-create-invoice` tokenem zalogowanego użytkownika. */
export async function createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return { ok: false, reason: "unauthorized", error: "Brak aktywnej sesji — zaloguj się ponownie." };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return { ok: false, reason: "not_configured", error: "Brak skonfigurowanego adresu Supabase." };

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/fakturownia-create-invoice`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(request),
    });
    if (res.status === 404) {
      return { ok: false, reason: "not_deployed", error: "Funkcja fakturownia-create-invoice nie jest jeszcze wdrożona na projekcie Supabase." };
    }
    const data = (await res.json().catch(() => null)) as CreateInvoiceResult | null;
    if (!data || typeof data !== "object" || !("ok" in data)) {
      return { ok: false, reason: "bad_response", error: `Nieoczekiwana odpowiedź serwera (HTTP ${res.status}).` };
    }
    return data;
  } catch (e) {
    return { ok: false, reason: "network", error: e instanceof Error ? e.message : String(e) };
  }
}
