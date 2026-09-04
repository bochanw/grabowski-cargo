"use client";

import { useState } from "react";
import { ZestawienieView } from "@/components/zestawienie/ZestawienieView";
import { PlanView } from "@/components/plan/PlanView";

type Widok = "zestawienie" | "plan";

const ZAKLADKI: { key: Widok; label: string }[] = [
  { key: "zestawienie", label: "Zestawienie" },
  { key: "plan", label: "Plan wspaniały" },
];

/**
 * Dwa widoki na TE SAME dane (`loads`): Zestawienie to tabela zleceń, Plan wspaniały to te same
 * zlecenia rozstawione na pojazdach. Zmiana w jednym widać w drugim od razu — obydwa czytają
 * ten sam cache TanStack Query odświeżany przez Realtime, więc nie ma tu żadnej synchronizacji
 * do napisania.
 */
export function AppViews() {
  const [widok, setWidok] = useState<Widok>("zestawienie");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex shrink-0 gap-1 border-b border-zinc-200 bg-zinc-100 px-2 pt-1 dark:border-zinc-800 dark:bg-zinc-900">
        {ZAKLADKI.map((zakladka) => (
          <button
            key={zakladka.key}
            type="button"
            onClick={() => setWidok(zakladka.key)}
            aria-current={widok === zakladka.key ? "page" : undefined}
            className={`rounded-t border border-b-0 px-3 py-1 text-sm ${
              widok === zakladka.key
                ? "border-zinc-300 bg-white font-semibold text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            {zakladka.label}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col">
        {widok === "zestawienie" ? <ZestawienieView /> : <PlanView />}
      </div>
    </div>
  );
}
