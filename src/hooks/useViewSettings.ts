"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { normalizeViewSettings, type ViewSettings } from "@/lib/view/viewSettings";

export const VIEW_SETTINGS_QUERY_KEY = ["view-settings"] as const;

/** `null` = użytkownik nie ma jeszcze swojego wiersza → widok domyślny (patrz resolveColumns). */
async function fetchViewSettings(): Promise<ViewSettings | null> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("user_view_settings")
    .select("settings")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return normalizeViewSettings(data.settings);
}

/**
 * Konfiguracja widoku bieżącego użytkownika. Bez Realtime — to ustawienia jednej osoby, nie dane
 * wspólne; zmiana jest widoczna natychmiast dzięki optymistycznemu `setQueryData` w
 * `useSaveViewSettings`, więc nie ma po co nasłuchiwać na własny zapis.
 */
export function useViewSettings() {
  return useQuery({ queryKey: VIEW_SETTINGS_QUERY_KEY, queryFn: fetchViewSettings, staleTime: 5 * 60 * 1000 });
}

export function useSaveViewSettings() {
  const queryClient = useQueryClient();

  return async function saveViewSettings(settings: ViewSettings): Promise<string | null> {
    // Optymistycznie: tabela ma się przestawić w tej samej klatce, w której użytkownik kliknął
    // checkbox — zapis do bazy tylko utrwala to, co już widzi.
    const previous = queryClient.getQueryData<ViewSettings | null>(VIEW_SETTINGS_QUERY_KEY) ?? null;
    queryClient.setQueryData<ViewSettings | null>(VIEW_SETTINGS_QUERY_KEY, settings);

    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) {
      queryClient.setQueryData<ViewSettings | null>(VIEW_SETTINGS_QUERY_KEY, previous);
      return "Brak aktywnej sesji — zaloguj się ponownie.";
    }

    const { error } = await supabase
      .from("user_view_settings")
      .upsert({ user_id: userId, settings }, { onConflict: "user_id" });

    if (error) {
      queryClient.setQueryData<ViewSettings | null>(VIEW_SETTINGS_QUERY_KEY, previous);
      return error.message;
    }
    return null;
  };
}
