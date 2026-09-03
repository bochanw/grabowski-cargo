import { supabase } from "./client";
import { normalizeParsedOrder, type ParsedOrder } from "@/types/parsedOrder";

// Odczyt dokumentu przez Claude (Edge Function `parse-order-pdf`) — FALLBACK dla dokumentów spoza
// znanych szablonów (src/lib/orderTemplates/). Znany szablon zawsze wygrywa: jest darmowy,
// natychmiastowy i deterministyczny, więc do modelu idą tylko dokumenty, których appka nie umie
// przeczytać sama. Kontrakt taki sam jak przy szablonie: funkcja NICZEGO nie zapisuje, tylko
// wypełnia formularz do sprawdzenia przez dyspozytora przed zapisem.
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
 * zalogowanego użytkownika — funkcja ma verify_jwt, więc bez nagłówka Authorization dostaniemy
 * 401 zamiast czytelnego błędu.
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
    if (res.status === 404) {
      return {
        ok: false,
        reason: "not_deployed",
        error: "Funkcja parse-order-pdf nie jest wdrożona na projekcie Supabase (odczyt przez Claude jeszcze nie działa).",
      };
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; parsed?: unknown; reason?: string; error?: string } | null;
    if (!data || typeof data !== "object" || typeof data.ok !== "boolean") {
      return { ok: false, reason: "bad_response", error: `Nieoczekiwana odpowiedź serwera (HTTP ${res.status}).` };
    }
    if (!data.ok) {
      return { ok: false, reason: data.reason ?? "error", error: data.error ?? "Nieznany błąd odczytu." };
    }
    // Model zwraca luźny obiekt (brakujące/nietypowe pola) — do formularza wchodzi dopiero po
    // normalizacji (ona sprowadza też nazwy terminali do listy rozwijanej, patrz normalizeParsedOrder).
    return { ok: true, parsed: normalizeParsedOrder(data.parsed) };
  } catch (e) {
    return { ok: false, reason: "network", error: e instanceof Error ? e.message : String(e) };
  }
}
