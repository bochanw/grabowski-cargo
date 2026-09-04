// Jak opisać dyspozytorowi stan sprawdzania statusów Baltic Hub — jedno miejsce, żeby pasek
// Zestawienia i podpowiedź guzika nie mówiły dwóch różnych rzeczy.
//
// Od kiedy terminal odpytuje rozszerzenie w czyjejś przeglądarce, „nic się nie dzieje" ma kilka
// różnych przyczyn i tylko część z nich dotyczy TEJ przeglądarki. Dlatego rozdzielamy dwa pytania:
//   1. Czy odczyt w ogóle żyje (czy KTOKOLWIEK sprawdzał ostatnio)? — wiersz `bhub_agent_state`.
//   2. Czy sprawdza TA przeglądarka? — stan rozszerzenia.
// Dyspozytor bez rozszerzenia, ale z kolegą, który je ma, widzi świeże statusy i nie musi nic
// robić — straszenie go czerwonym napisem byłoby fałszem.

import type { BhubAgentState } from "@/hooks/useBhubAgent";
import type { StanRozszerzenia } from "@/lib/bhub/extensionBridge";

/** Po tylu minutach ciszy uznajemy odczyt za zastały (trzy przebiegi po 15 minut). */
export const CISZA_MINUTY = 45;

export type TonStanu = "ok" | "uwaga" | "blad";

export interface OpisStanu {
  ton: TonStanu;
  /** Krótkie, do paska. */
  tekst: string;
  /** Pełne, do dymka nad guzikiem. */
  tytul: string;
}

function temu(iso: string, teraz: Date): string {
  const minuty = Math.round((teraz.getTime() - new Date(iso).getTime()) / 60_000);
  if (minuty < 1) return "przed chwilą";
  if (minuty < 60) return `${minuty} min temu`;
  const godziny = Math.round(minuty / 60);
  if (godziny < 24) return `${godziny} godz. temu`;
  return `${Math.round(godziny / 24)} dni temu`;
}

function minutTemu(iso: string, teraz: Date): number {
  return (teraz.getTime() - new Date(iso).getTime()) / 60_000;
}

export function opisOstatniegoSprawdzenia(
  agent: BhubAgentState | null | undefined,
  rozszerzenie: StanRozszerzenia | null,
  teraz: Date = new Date(),
): OpisStanu {
  const oTejPrzegladarce = !rozszerzenie
    ? ""
    : rozszerzenie.zainstalowane && rozszerzenie.zalogowane
      ? ` Ta przeglądarka sprawdza (konto ${rozszerzenie.email ?? "?"}).`
      : ` Ta przeglądarka NIE sprawdza: ${rozszerzenie.powod ?? "rozszerzenie nieaktywne"}`;

  if (!agent) {
    return {
      ton: "uwaga",
      tekst: "statusy: brak sprawdzeń",
      tytul: `Żadne rozszerzenie nie zgłosiło jeszcze sprawdzenia statusów w terminalach.${oTejPrzegladarce}`,
    };
  }

  const gdzie = agent.label ? ` (${agent.label})` : "";

  if (agent.last_error) {
    return {
      ton: "blad",
      tekst: `statusy: błąd ${temu(agent.last_seen_at, teraz)}`,
      tytul: `Ostatnie sprawdzenie${gdzie} skończyło się błędem: ${agent.last_error}${oTejPrzegladarce}`,
    };
  }

  const cisza = minutTemu(agent.last_ok_at ?? agent.last_seen_at, teraz);
  if (cisza > CISZA_MINUTY) {
    return {
      ton: "uwaga",
      tekst: `statusy: cisza od ${temu(agent.last_ok_at ?? agent.last_seen_at, teraz)}`,
      tytul:
        `Od ${Math.round(cisza)} minut nikt nie sprawdzał statusów w terminalach${gdzie}. ` +
        `Sprawdza je rozszerzenie w przeglądarce dyspozytora — jeśli jest zamknięta albo wylogowane, ` +
        `statusy przestają się odświeżać.${oTejPrzegladarce}`,
    };
  }

  return {
    ton: "ok",
    tekst: `statusy: ${temu(agent.last_ok_at ?? agent.last_seen_at, teraz)}`,
    tytul: `Ostatnie udane sprawdzenie${gdzie}: ${temu(agent.last_ok_at ?? agent.last_seen_at, teraz)}.${oTejPrzegladarce}`,
  };
}
