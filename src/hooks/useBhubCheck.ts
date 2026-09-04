"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bhubExtensionState, requestBhubCheck, type StanRozszerzenia } from "@/lib/bhub/extensionBridge";

/**
 * Sprawdzanie statusów w Baltic Hub — zlecane ROZSZERZENIU do Chrome, nie funkcji brzegowej.
 *
 * Powód jest zmierzony, nie teoretyczny: baltichub.com stoi za Cloudflare i reCAPTCHĄ, więc
 * odpytywanie z serwerowni albo przez płatną zdalną przeglądarkę kończyło się raz po raz na
 * przejściówce („Just a moment…"). Prawdziwa przeglądarka dyspozytora przechodzi to sama, a ta
 * sama droga zadziała u kolejnych terminali — one też będą się bronić, a API nie każdy da.
 *
 * Wynik NIE wraca tędy do tabeli: rozszerzenie odsyła odczyt do funkcji `bhub-status`, ta zapisuje
 * go przy zleceniach, a Zestawienie dostaje zmianę przez Realtime. Ten hook odpowiada wyłącznie za
 * „trwa/nie trwa", za komunikat o błędzie i za to, żeby BRAK rozszerzenia było widać, zamiast
 * cicho nie robić nic.
 */
export function useBhubCheck() {
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [extension, setExtension] = useState<StanRozszerzenia | null>(null);
  // Licznik równoległych sprawdzeń per zlecenie: dwa wywołania naraz (zapis zlecenia + „Sprawdź
  // teraz") nie mogą wygasić znaczka po zakończeniu tego pierwszego.
  const pending = useRef(new Map<string, number>());

  useEffect(() => {
    let anulowane = false;
    void bhubExtensionState().then((stan) => {
      if (!anulowane) setExtension(stan);
    });
    return () => {
      anulowane = true;
    };
  }, []);

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
        const result = await requestBhubCheck(loadIds);
        if (!result.ok) {
          setError(
            result.reason === "brak_rozszerzenia"
              ? result.error
              : `Nie udało się sprawdzić statusu w terminalu: ${result.error}`
          );
          return false;
        }
        return true;
      } finally {
        mark(loadIds, -1);
        void bhubExtensionState().then(setExtension);
      }
    },
    [mark]
  );

  return { checking, check, error, extension, clearError: () => setError(null) };
}
