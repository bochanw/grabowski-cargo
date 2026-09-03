// ============================================================
// Prefiltr — decyduje BEZ udziału modelu, czy mail w ogóle dotyczy zleceń.
//
// To jest jedyny hamulec kosztów w całym potoku: mail, który tu odpadnie, nie kosztuje ani grosza.
// Właściciel wybrał zakres „tylko z załącznikiem PDF + odpowiedzi w wątku", a jednocześnie postawił
// wymóg: „nawet jak klient dośle informację w treści/dodatkowym, program to zobaczy". Te dwa
// warunki godzą reguły 1 i 2 niżej — mail bez załącznika przechodzi, ale tylko wtedy, gdy da się go
// PEWNIE powiązać z konkretnym zleceniem.
//
// Świadomie NIE ma tu listy dozwolonych nadawców: właściciel wprost powiedział, że klientów jest
// wielu i lista nie jest zamknięta, więc nowy spedytor musi być widoczny od pierwszego maila.
// ============================================================

import type { RawMessage } from "./mailSource.ts";

// Krótsze numery zleceń pomijamy przy dopasowywaniu po treści — „12/26" trafiłoby przypadkiem
// w dowolny numer faktury albo datę w stopce maila.
export const MIN_ORDER_NUMBER_LENGTH = 5;

export interface Relevance {
  relevant: boolean;
  matchedLoadId: string | null;
  reason: string;
}

/** Ta sama normalizacja co `public.normalized_order_number` w SQL — obie strony porównania powstają tak samo. */
export function normalizeOrderNumber(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function assessRelevance(
  mail: Pick<RawMessage, "subject" | "bodyText" | "threadRefs" | "attachments">,
  loadsByNormalizedNumber: Map<string, { id: string; order_number: string }>,
  threadLoadByRef: Map<string, string>,
): Relevance {
  // 1) Numer zlecenia z bazy w temacie/treści — najmocniejszy sygnał, bo numer jest u klienta
  //    unikalny. Porównujemy formy znormalizowane, więc "ZD/1797/6/2026" w bazie trafia też
  //    w "ZD 1797-6-2026" albo "zd 1797 6 2026" w mailu.
  const haystack = normalizeOrderNumber(`${mail.subject} ${mail.bodyText}`);
  for (const [normalized, load] of loadsByNormalizedNumber) {
    if (normalized.length >= MIN_ORDER_NUMBER_LENGTH && haystack.includes(normalized)) {
      return { relevant: true, matchedLoadId: load.id, reason: `numer zlecenia ${load.order_number} w treści maila` };
    }
  }

  // 2) Odpowiedź w wątku, który już znamy — pokrywa „ok, potwierdzam" i „przesuwamy na piątek",
  //    czyli maile bez numeru zlecenia i bez załącznika.
  for (const ref of mail.threadRefs) {
    const loadId = threadLoadByRef.get(ref);
    if (loadId) return { relevant: true, matchedLoadId: loadId, reason: "odpowiedź w wątku znanego zlecenia" };
  }

  // 3) Załącznik PDF — kandydat na NOWE zlecenie od spedytora, którego jeszcze nie znamy.
  if (mail.attachments.length > 0) {
    return { relevant: true, matchedLoadId: null, reason: `załącznik PDF (${mail.attachments.length})` };
  }

  return { relevant: false, matchedLoadId: null, reason: "brak PDF-a, numeru zlecenia i powiązania z wątkiem" };
}
