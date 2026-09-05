import { supabase } from "./client";

/**
 * Prośba o SERWEROWE sprawdzenie statusów (BCT, GCT) — funkcja brzegowa `bhub-status`, działanie
 * `cykl`. Terminale publiczne pobiera serwer, więc dyspozytor dostaje odpowiedź bez otwierania
 * czegokolwiek w przeglądarce i bez rozszerzenia.
 *
 * O tym, KTÓRE zlecenia obsłuży serwer, decyduje wyłącznie serwer (tabela `terminal_sources`).
 * Dlatego odpowiedź zawiera `dlaWtyczki` — listę zleceń, o które trzeba poprosić rozszerzenie.
 * Gdyby appka próbowała rozstrzygać to sama, przestawienie terminala na drogę awaryjną wymagałoby
 * wdrożenia appki, a nie zmiany jednego wiersza w bazie.
 */
export type CheckTerminalResult =
  | { ok: true; updated: number; obsluzone: string[]; dlaWtyczki: string[]; problems: string[] }
  | { ok: false; reason: string; error: string; dlaWtyczki: string[] };

export async function checkTerminalStatus(loadIds: string[]): Promise<CheckTerminalResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    // Bez sesji nie wiemy, które zlecenia są serwerowe — oddajemy WSZYSTKIE rozszerzeniu, żeby
    // brak sesji nie kasował po cichu sprawdzenia (rozszerzenie loguje się osobno).
    return { ok: false, reason: "unauthorized", error: "Brak aktywnej sesji — zaloguj się ponownie.", dlaWtyczki: loadIds };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, reason: "not_configured", error: "Brak skonfigurowanego adresu Supabase.", dlaWtyczki: loadIds };
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/bhub-status`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action: "cykl", loadIds }),
    });
    const dane = (await res.json().catch(() => null)) as
      | { ok?: boolean; updated?: number; obsluzone?: string[]; dlaWtyczki?: string[]; problems?: string[]; error?: string }
      | null;

    if (!res.ok || !dane?.ok) {
      const powod = res.status === 404 ? "Funkcja `bhub-status` nie jest wdrożona." : dane?.error ?? `HTTP ${res.status}`;
      return { ok: false, reason: "funkcja", error: powod, dlaWtyczki: loadIds };
    }

    return {
      ok: true,
      updated: dane.updated ?? 0,
      obsluzone: dane.obsluzone ?? [],
      dlaWtyczki: dane.dlaWtyczki ?? [],
      problems: dane.problems ?? [],
    };
  } catch (e) {
    return {
      ok: false,
      reason: "siec",
      error: e instanceof Error ? e.message : String(e),
      dlaWtyczki: loadIds,
    };
  }
}
