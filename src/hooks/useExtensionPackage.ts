"use client";

import { useQuery } from "@tanstack/react-query";
import { pobierzOpisPaczki } from "@/lib/bhub/extensionPackage";

/**
 * Opis paczki z wtyczką wgranej razem z appką (`public/rozszerzenie/wersja.json`).
 *
 * Pobierany raz na sesję zakładki: plik zmienia się tylko przy wgraniu nowej appki, a wtedy i tak
 * przeładowuje się cała strona. `retry: false`, bo jedyny realny powód błędu — build bez
 * `scripts/build-extension-zip.mjs` — nie minie sam i ma być widoczny od razu.
 */
export function useExtensionPackage() {
  return useQuery({
    queryKey: ["wtyczka-paczka"],
    queryFn: pobierzOpisPaczki,
    staleTime: Infinity,
    retry: false,
  });
}
