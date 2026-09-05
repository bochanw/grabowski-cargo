"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bhubExtensionState, requestBhubCheck, type StanRozszerzenia } from "@/lib/bhub/extensionBridge";
import { checkTerminalStatus } from "@/lib/supabase/checkTerminalStatus";

/**
 * Sprawdzanie statusów w terminalach — DWIE drogi, bo terminale bronią się bardzo różnie.
 *
 *   SERWER (`bhub-status`, działanie `cykl`) — terminale publiczne: BCT i GCT. Zwykłe formularze
 *   bez logowania i bez captchy, więc funkcja brzegowa pobiera je sama. Dyspozytor nie musi mieć
 *   nic włączonego, a odczyt chodzi też sam z siebie co kwadrans.
 *
 *   ROZSZERZENIE DO CHROME — Baltic Hub i wszystko, co wymaga logowania albo się broni.
 *   baltichub.com stoi za Cloudflare i reCAPTCHĄ: odpytywanie z serwerowni albo przez płatną
 *   zdalną przeglądarkę kończyło się raz po raz na przejściówce („Just a moment…"). Prawdziwa
 *   przeglądarka dyspozytora przechodzi to sama.
 *
 * KOLEJNOŚĆ JEST WAŻNA I NIE JEST DOWOLNA: najpierw pytamy serwer, bo to ON wie, które terminale
 * obsługuje dziś którą drogą (tabela `terminal_sources` — przełącznik awaryjny). Rozszerzenie
 * dostaje dokładnie te zlecenia, które serwer oddał jako `dlaWtyczki`. Gdyby appka dzieliła to
 * sama, przestawienie terminala na drogę awaryjną wymagałoby wdrożenia appki.
 *
 * Wynik NIE wraca tędy do tabeli: obie drogi zapisują odczyt przez `bhub-status`, a Zestawienie
 * dostaje zmianę przez Realtime. Ten hook odpowiada wyłącznie za „trwa/nie trwa", za komunikat
 * o błędzie i za to, żeby BRAK rozszerzenia było widać, zamiast cicho nie robić nic.
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
        // 1. Serwer — terminale publiczne. Odpowiedź mówi, co zostało dla rozszerzenia.
        const serwer = await checkTerminalStatus(loadIds);
        const dlaWtyczki = serwer.dlaWtyczki;

        // 2. Rozszerzenie — reszta. Gdy serwer obsłużył WSZYSTKO, nie zawracamy mu głowy: dyspozytor
        // bez rozszerzenia nie może dostać komunikatu o jego braku, skoro nie było ono do niczego
        // potrzebne.
        const wtyczka = dlaWtyczki.length > 0 ? await requestBhubCheck(dlaWtyczki) : null;

        if (!serwer.ok && dlaWtyczki.length === 0) {
          setError(`Nie udało się sprawdzić statusu w terminalu: ${serwer.error}`);
          return false;
        }
        if (wtyczka && !wtyczka.ok) {
          setError(
            wtyczka.reason === "brak_rozszerzenia"
              ? wtyczka.error
              : `Nie udało się sprawdzić statusu w terminalu: ${wtyczka.error}`
          );
          return false;
        }
        // Serwer odpowiedział, ale przy części zleceń zapisał problem (terminal nie odpowiedział,
        // zmienił formularz). Nie wolno tego przemilczeć — przy zleceniu i tak stoi powód.
        if (serwer.ok && serwer.problems.length > 0) {
          setError(`Terminal: ${serwer.problems[0]}`);
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
