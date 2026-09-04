"use client";

import { useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { PlanAbsence, PlanVehicle } from "@/types/plan";

export const PLAN_VEHICLES_QUERY_KEY = ["plan_vehicles"] as const;
export const PLAN_ABSENCES_QUERY_KEY = ["plan_absences"] as const;

/**
 * Ustawienia wierszy planu i nieobecności — ten sam wzorzec Realtime → cache co useLoads.
 * Nazwa kanału z `useId()`, bo hook bywa użyty w kilku komponentach naraz (patrz useContractors:
 * powtórzona nazwa kanału = wyjątek przy drugim subscribe i biały ekran).
 */
function useRealtimeTable<T>(table: string, queryKey: readonly string[], fetcher: () => Promise<T[]>) {
  const queryClient = useQueryClient();
  const channelId = useId();
  const query = useQuery({ queryKey, queryFn: fetcher });

  useEffect(() => {
    let subscribedBefore = false;
    const channel = supabase
      .channel(`${table}-changes-${channelId}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, () => {
        queryClient.invalidateQueries({ queryKey });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (subscribedBefore) queryClient.invalidateQueries({ queryKey });
          subscribedBefore = true;
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
    // `queryKey` to stała tablica z modułu — celowo poza zależnościami, żeby nie odsubskrybować
    // kanału przy każdym renderze.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, channelId, table]);

  return query;
}

async function fetchPlanVehicles(): Promise<PlanVehicle[]> {
  const { data, error } = await supabase.from("plan_vehicles").select("*");
  if (error) throw error;
  return data ?? [];
}

async function fetchPlanAbsences(): Promise<PlanAbsence[]> {
  const { data, error } = await supabase.from("plan_absences").select("*").order("start_date", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export function usePlanVehicles() {
  return useRealtimeTable<PlanVehicle>("plan_vehicles", PLAN_VEHICLES_QUERY_KEY, fetchPlanVehicles);
}

export function usePlanAbsences() {
  return useRealtimeTable<PlanAbsence>("plan_absences", PLAN_ABSENCES_QUERY_KEY, fetchPlanAbsences);
}

/**
 * Zapis ustawień wiersza (kierowca etatowy, ładowność, kolejność, ukrycie). Wiersz powstaje dopiero
 * tutaj — pusty plan nie zakłada w bazie rekordu dla każdego z kilkudziesięciu aut.
 */
export function useSavePlanVehicle() {
  const queryClient = useQueryClient();
  return async function savePlanVehicle(
    vehiclePlate: string,
    patch: Partial<Omit<PlanVehicle, "vehicle_plate" | "created_at" | "updated_at">>
  ): Promise<string | null> {
    const { error } = await supabase
      .from("plan_vehicles")
      .upsert({ vehicle_plate: vehiclePlate, ...patch }, { onConflict: "vehicle_plate" });
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: PLAN_VEHICLES_QUERY_KEY });
    return null;
  };
}

export function useSavePlanAbsence() {
  const queryClient = useQueryClient();
  return async function savePlanAbsence(input: {
    vehicle_plate: string;
    start_date: string;
    end_date: string;
    reason: string | null;
  }): Promise<string | null> {
    const { error } = await supabase.from("plan_absences").insert(input);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: PLAN_ABSENCES_QUERY_KEY });
    return null;
  };
}

export function useDeletePlanAbsence() {
  const queryClient = useQueryClient();
  return async function deletePlanAbsence(id: string): Promise<string | null> {
    const { error } = await supabase.from("plan_absences").delete().eq("id", id);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: PLAN_ABSENCES_QUERY_KEY });
    return null;
  };
}
