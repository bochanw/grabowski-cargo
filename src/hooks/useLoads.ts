"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Load } from "@/types/load";

export const LOADS_QUERY_KEY = ["loads"] as const;

async function fetchLoads(): Promise<Load[]> {
  const { data, error } = await supabase
    .from("loads")
    .select("*")
    .order("load_date", { ascending: true })
    .order("order_number", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Zestawienie live przez Supabase Realtime — bez odświeżania strony.
 * Reconnect po zerwaniu sieci robi zwykły refetch (Realtime nie gwarantuje
 * dostarczenia zdarzeń z okna rozłączenia, więc nie próbujemy gapless replay).
 */
export function useLoads() {
  const queryClient = useQueryClient();
  const hasSubscribedBefore = useRef(false);

  const query = useQuery({ queryKey: LOADS_QUERY_KEY, queryFn: fetchLoads });

  useEffect(() => {
    const channel = supabase
      .channel("loads-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "loads" },
        (payload) => {
          queryClient.setQueryData<Load[]>(LOADS_QUERY_KEY, (current) => {
            if (!current) return current;

            if (payload.eventType === "INSERT") {
              const newRow = payload.new as Load;
              if (current.some((load) => load.id === newRow.id)) return current;
              return [...current, newRow];
            }

            if (payload.eventType === "UPDATE") {
              const updatedRow = payload.new as Load;
              return current.map((load) =>
                load.id === updatedRow.id ? updatedRow : load
              );
            }

            if (payload.eventType === "DELETE") {
              const deletedId = (payload.old as Partial<Load>).id;
              return current.filter((load) => load.id !== deletedId);
            }

            return current;
          });
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (hasSubscribedBefore.current) {
            queryClient.invalidateQueries({ queryKey: LOADS_QUERY_KEY });
          }
          hasSubscribedBefore.current = true;
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return query;
}

/**
 * Zapis jednego pola wprost z tabeli (edycja inline, Enter zatwierdza). Optymistycznie od razu w
 * cache TanStack Query — Realtime i tak przyśle UPDATE, ale bez czekania na niego komórka nie
 * "mruga". Przy błędzie cofamy do poprzedniej wartości i zwracamy komunikat.
 */
export function useUpdateLoadField() {
  const queryClient = useQueryClient();

  return async function updateLoadField<K extends keyof Load>(
    id: string,
    key: K,
    value: Load[K]
  ): Promise<string | null> {
    const previous = queryClient.getQueryData<Load[]>(LOADS_QUERY_KEY);
    queryClient.setQueryData<Load[]>(LOADS_QUERY_KEY, (current) =>
      current?.map((load) => (load.id === id ? { ...load, [key]: value } : load))
    );
    const { error } = await supabase.from("loads").update({ [key]: value }).eq("id", id);
    if (error) {
      queryClient.setQueryData(LOADS_QUERY_KEY, previous);
      return error.message;
    }
    return null;
  };
}
