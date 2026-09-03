import { supabase } from "./client";

// Wywołanie Edge Function `bhub-status` — sprawdzenie kontenerów w Baltic Hub NA ŻĄDANIE:
// zaraz po zapisaniu zlecenia z podjęciem z BHub (właściciel: "po wgraniu zlecenia które
// pobieramy z BHub program wchodzi na stronę i sprawdza status") oraz z guzika "Sprawdź teraz".
// Cykliczne odpytywanie co 15 minut robi ta sama funkcja wołana przez pg_cron.
//
// Kontrakt: funkcja SAMA zapisuje wynik do `loads` (inaczej niż odczyt dokumentów, który tylko
// wypełnia formularz) — tu nie ma czego dawać dyspozytorowi do zatwierdzenia, to odczyt stanu
// z terminala, a nie propozycja zmiany zlecenia. Do tabeli wynik wraca przez Realtime.

export type CheckBhubResult =
  | { ok: true; checked: number; updated: number }
  | { ok: false; reason: string; error: string };

export async function checkBhubStatus(loadIds?: string[]): Promise<CheckBhubResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    return { ok: false, reason: "unauthorized", error: "Brak aktywnej sesji — zaloguj się ponownie." };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, reason: "not_configured", error: "Brak skonfigurowanego adresu Supabase." };
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/bhub-status`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
      // Bez loadIds funkcja bierze wszystko, co podlega śledzeniu (tak woła ją cron).
      body: JSON.stringify(loadIds ? { loadIds } : {}),
    });
    if (res.status === 404) {
      return {
        ok: false,
        reason: "not_deployed",
        error: "Funkcja bhub-status nie jest wdrożona na projekcie Supabase — sprawdzanie statusów jeszcze nie działa.",
      };
    }
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; checked?: number; updated?: number; reason?: string; error?: string }
      | null;
    if (!data || typeof data.ok !== "boolean") {
      return { ok: false, reason: "bad_response", error: `Nieoczekiwana odpowiedź serwera (HTTP ${res.status}).` };
    }
    if (!data.ok) return { ok: false, reason: data.reason ?? "error", error: data.error ?? "Nieznany błąd sprawdzenia." };
    return { ok: true, checked: data.checked ?? 0, updated: data.updated ?? 0 };
  } catch (e) {
    return { ok: false, reason: "network", error: e instanceof Error ? e.message : String(e) };
  }
}
