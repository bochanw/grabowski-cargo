import { supabase } from "./client";

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

export type ParseOrderPdfResult =
  | { ok: true; parsed: ParsedOrder }
  | { ok: false; reason: string; error: string };

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:application/pdf;base64,XXXX — funkcja brzegowa chce samego base64.
      const base64 = result.slice(result.indexOf(",") + 1);
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Woła Edge Function `parse-order-pdf` (patrz supabase/functions/parse-order-pdf) tokenem
 * zalogowanego użytkownika — funkcja i tak ma verify_jwt, ale bez nagłówka Authorization
 * dostaniemy 401 zamiast czytelnego błędu.
 */
export async function parseOrderPdf(file: File): Promise<ParseOrderPdfResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    return { ok: false, reason: "unauthorized", error: "Brak aktywnej sesji — zaloguj się ponownie." };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, reason: "not_configured", error: "Brak skonfigurowanego adresu Supabase." };
  }

  const pdfBase64 = await fileToBase64(file);

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/parse-order-pdf`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pdfBase64 }),
    });
    return (await res.json()) as ParseOrderPdfResult;
  } catch (e) {
    return { ok: false, reason: "network", error: e instanceof Error ? e.message : String(e) };
  }
}
