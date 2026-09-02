"use client";

import { useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { Contractor, ContractorInput } from "@/types/contractor";

export const CONTRACTORS_QUERY_KEY = ["contractors"] as const;

async function fetchContractors(): Promise<Contractor[]> {
  const { data, error } = await supabase.from("contractors").select("*").order("name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Kontrahenci na żywo — ten sam wzorzec Realtime → cache co useLoads.
 *
 * Nazwa kanału MUSI być unikalna per instancja hooka: `supabase.channel(nazwa)` zwraca ISTNIEJĄCY
 * kanał o tej samej nazwie, a ponowne `subscribe()` na nim rzuca wyjątek ("tried to subscribe
 * multiple times") — dokładnie tak wywalał się ekran "This page couldn't load" po kliknięciu
 * "Kontrahenci" (tabela i okno wołały ten hook naraz). Stąd `useId()` w nazwie.
 */
export function useContractors() {
  const queryClient = useQueryClient();
  const channelId = useId();
  const query = useQuery({ queryKey: CONTRACTORS_QUERY_KEY, queryFn: fetchContractors });

  useEffect(() => {
    let subscribedBefore = false;
    const channel = supabase
      .channel(`contractors-changes-${channelId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "contractors" }, (payload) => {
        queryClient.setQueryData<Contractor[]>(CONTRACTORS_QUERY_KEY, (current) => {
          if (!current) return current;
          if (payload.eventType === "INSERT") {
            const row = payload.new as Contractor;
            return current.some((c) => c.id === row.id) ? current : [...current, row].sort((a, b) => a.name.localeCompare(b.name, "pl"));
          }
          if (payload.eventType === "UPDATE") {
            const row = payload.new as Contractor;
            return current.map((c) => (c.id === row.id ? row : c)).sort((a, b) => a.name.localeCompare(b.name, "pl"));
          }
          if (payload.eventType === "DELETE") {
            const id = (payload.old as Partial<Contractor>).id;
            return current.filter((c) => c.id !== id);
          }
          return current;
        });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (subscribedBefore) queryClient.invalidateQueries({ queryKey: CONTRACTORS_QUERY_KEY });
          subscribedBefore = true;
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return query;
}

export function useSaveContractor() {
  const queryClient = useQueryClient();
  return async function saveContractor(input: ContractorInput, id?: string): Promise<string | null> {
    const { error } = id
      ? await supabase.from("contractors").update(input).eq("id", id)
      : await supabase.from("contractors").insert(input);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: CONTRACTORS_QUERY_KEY });
    return null;
  };
}

export function useDeleteContractor() {
  const queryClient = useQueryClient();
  return async function deleteContractor(id: string): Promise<string | null> {
    const { error } = await supabase.from("contractors").delete().eq("id", id);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: CONTRACTORS_QUERY_KEY });
    return null;
  };
}
