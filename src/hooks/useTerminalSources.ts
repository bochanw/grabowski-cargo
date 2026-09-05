"use client";

import { useId, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";

/**
 * Którą drogą appka odpytuje każdy terminal (tabela `terminal_sources`, migracja 0033).
 *
 *   `serwer`  — pobiera funkcja brzegowa, co kwadrans, bez udziału czyjejkolwiek przeglądarki.
 *   `wtyczka` — pobiera rozszerzenie do Chrome z przeglądarki dyspozytora.
 *
 * To jest PRZEŁĄCZNIK AWARYJNY, nie ustawienie do zabawy: gdy publiczny terminal zacznie się
 * bronić przed automatami albo zmieni formularz, przestawienie go na `wtyczka` wraca do drogi
 * przez przeglądarkę — bez wdrożenia funkcji i bez aktualizacji rozszerzenia u dyspozytorów.
 * Baltic Hub jest na `wtyczka` na stałe (Cloudflare + reCAPTCHA) i przestawienie go na `serwer`
 * skończy się błędem przy każdym zleceniu — dlatego okno o tym uprzedza.
 */
export type DrogaTerminala = "serwer" | "wtyczka";

export interface TerminalSource {
  terminal: string;
  mode: DrogaTerminala;
  note: string | null;
}

export function useTerminalSources() {
  const queryClient = useQueryClient();
  // Nazwa kanału per instancja hooka — patrz pułapka z `ContractorsDialog`: `supabase.channel(nazwa)`
  // zwraca ISTNIEJĄCĄ instancję dla powtórzonej nazwy, a drugie `.on(...).subscribe()` na niej rzuca.
  const instancja = useId();

  const query = useQuery<TerminalSource[]>({
    queryKey: ["terminal_sources"],
    queryFn: async () => {
      const { data, error } = await supabase.from("terminal_sources").select("terminal, mode, note").order("terminal");
      if (error) throw new Error(error.message);
      return (data ?? []) as TerminalSource[];
    },
  });

  useEffect(() => {
    const kanal = supabase
      .channel(`terminal-sources-${instancja}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "terminal_sources" }, () => {
        void queryClient.invalidateQueries({ queryKey: ["terminal_sources"] });
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(kanal);
    };
  }, [instancja, queryClient]);

  const przestaw = useMutation({
    mutationFn: async ({ terminal, mode }: { terminal: string; mode: DrogaTerminala }) => {
      const { error } = await supabase
        .from("terminal_sources")
        .update({ mode, updated_at: new Date().toISOString() })
        .eq("terminal", terminal);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["terminal_sources"] }),
  });

  return { drogi: query.data ?? [], isLoading: query.isLoading, przestaw };
}
