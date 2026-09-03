"use client";

import { useCallback, useRef, useState } from "react";
import { checkBhubStatus } from "@/lib/supabase/checkBhubStatus";

/**
 * Sprawdzanie statusów w Baltic Hub z przeglądarki — plus zbiór zleceń, dla których sprawdzenie
 * właśnie trwa (przy numerze kontenera kręci się wtedy znaczek; właściciel: "możesz jakiś znaczek
 * zostawić przy kontenerze jak będzie się odświeżał").
 *
 * Wynik NIE wraca tędy do tabeli — funkcja brzegowa zapisuje go do `loads`, a Zestawienie dostaje
 * zmianę przez Realtime. Ten hook odpowiada wyłącznie za "trwa/nie trwa" i za komunikat o błędzie.
 * Odpytywanie cykliczne (co 15 minut) robi cron po stronie bazy, bez udziału przeglądarki — inaczej
 * statusy przestawałyby się odświeżać, gdy nikt nie ma otwartej karty.
 */
export function useBhubCheck() {
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Licznik równoległych sprawdzeń per zlecenie: dwa wywołania naraz (zapis zlecenia + "Sprawdź
  // teraz") nie mogą wygasić znaczka po zakończeniu tego pierwszego.
  const pending = useRef(new Map<string, number>());

  const mark = useCallback((ids: string[], delta: number) => {
    for (const id of ids) {
      const next = (pending.current.get(id) ?? 0) + delta;
      if (next > 0) pending.current.set(id, next);
      else pending.current.delete(id);
    }
    setChecking(new Set(pending.current.keys()));
  }, []);

  const check = useCallback(
    async (loadIds: string[]): Promise<boolean> => {
      if (loadIds.length === 0) return true;
      setError(null);
      mark(loadIds, 1);
      try {
        const result = await checkBhubStatus(loadIds);
        if (!result.ok) {
          setError(`Nie udało się sprawdzić statusu w Baltic Hub: ${result.error}`);
          return false;
        }
        return true;
      } finally {
        mark(loadIds, -1);
      }
    },
    [mark]
  );

  return { checking, check, error, clearError: () => setError(null) };
}
