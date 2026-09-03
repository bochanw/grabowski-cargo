"use client";

import { useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";

export const BHUB_AGENT_QUERY_KEY = ["bhub_agent_state"] as const;

export interface BhubAgentState {
  agent_id: string;
  label: string | null;
  last_seen_at: string;
  last_ok_at: string | null;
  last_error: string | null;
  checked_count: number;
}

/**
 * Kto ostatnio sprawdzał statusy w Baltic Hub i kiedy.
 *
 * PO CO: od kiedy terminal odpytuje ROZSZERZENIE w przeglądarce dyspozytora, odczyt zależy od
 * cudzego komputera — wyłączona przeglądarka, wylogowane rozszerzenie albo blokada Cloudflare
 * zatrzymują odświeżanie. Bez tego wiersza działoby się to w ciszy i dyspozytor patrzyłby na
 * wczorajszy stan przekonany, że jest dzisiejszy. Ta sama zasada co przy skrzynce mailowej.
 *
 * Bierzemy NAJŚWIEŻSZY wiersz ze wszystkich instalacji: wystarczy, że sprawdza ktokolwiek.
 */
async function fetchAgentState(): Promise<BhubAgentState | null> {
  const { data, error } = await supabase
    .from("bhub_agent_state")
    .select("agent_id, label, last_seen_at, last_ok_at, last_error, checked_count")
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as BhubAgentState) ?? null;
}

export function useBhubAgent() {
  const queryClient = useQueryClient();
  // Nazwa kanału per instancja hooka — patrz pułapka opisana w useContractors.
  const channelId = useId();
  const query = useQuery({ queryKey: BHUB_AGENT_QUERY_KEY, queryFn: fetchAgentState });

  useEffect(() => {
    const channel = supabase
      .channel(`bhub-agent-${channelId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "bhub_agent_state" }, () => {
        // Wierszy jest tyle, co instalacji rozszerzenia (jedna, może dwie), a interesuje nas
        // wyłącznie najświeższy — prościej i pewniej pobrać go na nowo niż scalać zdarzenia.
        queryClient.invalidateQueries({ queryKey: BHUB_AGENT_QUERY_KEY });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return query;
}
