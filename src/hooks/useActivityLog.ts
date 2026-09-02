"use client";

import { useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { ActivityLogEntry } from "@/types/activityLog";

export const ACTIVITY_LOG_QUERY_KEY = ["activity_log"] as const;
const LIMIT = 200;

async function fetchActivityLog(): Promise<ActivityLogEntry[]> {
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

/**
 * Dziennik zmian na żywo — wpisy dopisuje trigger w bazie (patrz migracja 0003), appka tylko czyta.
 * Ten sam wzorzec co useLoads: Realtime INSERT → setQueryData, reconnect → refetch. Tabela jest
 * insert-only, więc UPDATE/DELETE nie obsługujemy.
 */
export function useActivityLog(enabled: boolean) {
  const queryClient = useQueryClient();
  // Unikalna nazwa kanału per instancja — patrz komentarz w useContractors.
  const channelId = useId();
  const query = useQuery({ queryKey: ACTIVITY_LOG_QUERY_KEY, queryFn: fetchActivityLog, enabled });

  useEffect(() => {
    if (!enabled) return;
    let subscribedBefore = false;
    const channel = supabase
      .channel(`activity-log-changes-${channelId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, (payload) => {
        const entry = payload.new as ActivityLogEntry;
        queryClient.setQueryData<ActivityLogEntry[]>(ACTIVITY_LOG_QUERY_KEY, (current) => {
          if (!current) return current;
          if (current.some((e) => e.id === entry.id)) return current;
          return [entry, ...current].slice(0, LIMIT);
        });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (subscribedBefore) queryClient.invalidateQueries({ queryKey: ACTIVITY_LOG_QUERY_KEY });
          subscribedBefore = true;
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, queryClient, channelId]);

  return query;
}
