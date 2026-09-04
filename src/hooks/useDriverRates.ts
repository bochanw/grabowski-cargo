"use client";

import { useEffect, useId, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { DriverRateRow } from "@/lib/driverRates/rates";

export const DRIVER_RATES_QUERY_KEY = ["driver_rates"] as const;

async function fetchDriverRates(): Promise<DriverRateRow[]> {
  const { data, error } = await supabase
    .from("driver_rates")
    .select("prefix, city, rate_to_15t, rate_over_15t, rate_over_22t")
    .order("prefix", { ascending: true });
  if (error) throw error;
  // PostgREST zwraca `numeric` jako string — bez tego suma stawek w zestawieniu byłaby sklejaniem
  // napisów, a porównanie "czy wszystkie wiersze miasta mają te same stawki" porównywałoby napisy.
  return (data ?? []).map((row) => ({
    prefix: String(row.prefix),
    city: row.city,
    rate_to_15t: Number(row.rate_to_15t),
    rate_over_15t: Number(row.rate_over_15t),
    rate_over_22t: Number(row.rate_over_22t),
  }));
}

/**
 * Cennik stawek dla kierowców (migracja 0030) — z Realtime, bo poprawka stawki u jednej osoby ma
 * być widoczna u pozostałych bez odświeżania. Nazwa kanału z `useId()`: ten sam hook stoi
 * w Zestawieniu i w zakładce „Stawki kierowców" naraz, a powtórzona nazwa kanału rzuca wyjątkiem
 * przy drugim `subscribe()` (patrz CLAUDE.md, pułapka z ContractorsDialog).
 */
export function useDriverRates() {
  const queryClient = useQueryClient();
  const channelId = useId();
  const hasSubscribedBefore = useRef(false);

  const query = useQuery({ queryKey: DRIVER_RATES_QUERY_KEY, queryFn: fetchDriverRates });

  useEffect(() => {
    const channel = supabase
      .channel(`driver-rates-changes-${channelId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "driver_rates" }, () => {
        queryClient.invalidateQueries({ queryKey: DRIVER_RATES_QUERY_KEY });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (hasSubscribedBefore.current) queryClient.invalidateQueries({ queryKey: DRIVER_RATES_QUERY_KEY });
          hasSubscribedBefore.current = true;
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return query;
}

/** Zapis jednego wiersza cennika (dodanie albo poprawka stawek). Zwraca komunikat błędu albo null. */
export function useSaveDriverRate() {
  const queryClient = useQueryClient();

  return async function saveDriverRate(row: DriverRateRow): Promise<string | null> {
    const { error } = await supabase.from("driver_rates").upsert({
      prefix: row.prefix,
      city: row.city,
      rate_to_15t: row.rate_to_15t,
      rate_over_15t: row.rate_over_15t,
      rate_over_22t: row.rate_over_22t,
    });
    if (error) return error.message;
    await queryClient.invalidateQueries({ queryKey: DRIVER_RATES_QUERY_KEY });
    return null;
  };
}

export function useDeleteDriverRate() {
  const queryClient = useQueryClient();

  return async function deleteDriverRate(prefix: string): Promise<string | null> {
    const { error } = await supabase.from("driver_rates").delete().eq("prefix", prefix);
    if (error) return error.message;
    await queryClient.invalidateQueries({ queryKey: DRIVER_RATES_QUERY_KEY });
    return null;
  };
}
