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
// Jedno źródło prawdy dla normalizacji numeru i progu długości: src/lib/loads/orderNumber.ts (kopia
// dla Deno generowana przez scripts/build-edge-shared.mjs). Ta sama reguła stoi w SQL jako
// `public.normalized_order_number` — obie strony porównania muszą powstawać tak samo.
import {
  MIN_CONTAINER_NUMBER_LENGTH,
  MIN_ORDER_NUMBER_LENGTH,
  normalizeContainerNumber,
  normalizeOrderNumber,
  orderNumberVariants,
} from "./shared/orderNumber.ts";

export { MIN_ORDER_NUMBER_LENGTH, normalizeOrderNumber };

export interface Relevance {
  relevant: boolean;
  matchedLoadId: string | null;
  reason: string;
}

/**
 * Reguła „czytaj tylko oznaczone" (migracja 0024). Właściciel: „pracownik klienta oznacza zlecenie
 * czerwonym kolorkiem […] oznaczając że jest to zlecenie do wpisania".
 *
 * `categories` puste = liczy się DOWOLNE oznaczenie (jakakolwiek kategoria albo flaga). Tak jest
 * na starcie celowo: nazwa kolorowej kategorii jest dowolna i zależy od ustawień skrzynki klienta,
 * a zgadnięcie jej po cichu znaczyłoby przegapianie zleceń. Po pierwszym przebiegu widać w Skrzynce,
 * czym te maile są NAPRAWDĘ oznaczone, i wtedy można zawęzić regułę do jednej kategorii.
 */
export interface MarkingRule {
  onlyMarked: boolean;
  categories: string[];
}

export const ANY_MARKING: MarkingRule = { onlyMarked: false, categories: [] };

/** Czy człowiek oznaczył ten mail jako „do wpisania". */
export function isMarked(
  mail: Pick<RawMessage, "categories" | "flagged">,
  rule: MarkingRule,
): boolean {
  if (!rule.onlyMarked) return true;
  if (rule.categories.length > 0) {
    const wanted = rule.categories.map((c) => c.trim().toLowerCase());
    return mail.categories.some((c) => wanted.includes(c.trim().toLowerCase()));
  }
  return mail.flagged || mail.categories.length > 0;
}

export function assessRelevance(
  mail: Pick<RawMessage, "subject" | "bodyText" | "threadRefs" | "attachments" | "categories" | "flagged">,
  loadsByNormalizedNumber: Map<string, { id: string; order_number: string; container_number?: string | null }>,
  threadLoadByRef: Map<string, string>,
  marking: MarkingRule = ANY_MARKING,
): Relevance {
  // 1) Numer zlecenia z bazy w temacie/treści — najmocniejszy sygnał, bo numer jest u klienta
  //    unikalny. Porównujemy formy znormalizowane, więc "ZD/1797/6/2026" w bazie trafia też
  //    w "ZD 1797-6-2026" albo "zd 1797 6 2026" w mailu. Człony bywają zresztą poskładane w innej
  //    kolejności ("KPB/87" i "87/KPB" to u klienta jedno zlecenie), więc szukamy każdego wariantu.
  const haystack = normalizeOrderNumber(`${mail.subject} ${mail.bodyText}`);
  for (const [normalized, load] of loadsByNormalizedNumber) {
    if (normalized.length < MIN_ORDER_NUMBER_LENGTH) continue;
    for (const variant of orderNumberVariants(load.order_number)) {
      if (haystack.includes(variant)) {
        return {
          relevant: true,
          matchedLoadId: load.id,
          reason: `numer zlecenia ${load.order_number} w treści maila`,
        };
      }
    }
  }

  // 1b) Numer kontenera — słabszy, bo ten sam kontener wraca na kolejne zlecenia, ale na tyle
  //     charakterystyczny (4 litery + 7 cyfr), że mail go zawierający prawie na pewno dotyczy
  //     przewozu. Mail i tak trafia do Skrzynki jako PROPOZYCJA, którą zatwierdza dyspozytor.
  for (const load of loadsByNormalizedNumber.values()) {
    const container = normalizeContainerNumber(load.container_number);
    if (container.length >= MIN_CONTAINER_NUMBER_LENGTH && haystack.includes(container)) {
      return {
        relevant: true,
        matchedLoadId: load.id,
        reason: `numer kontenera ${load.container_number} w treści maila (zlecenie ${load.order_number})`,
      };
    }
  }

  // 2) Odpowiedź w wątku, który już znamy — pokrywa „ok, potwierdzam" i „przesuwamy na piątek",
  //    czyli maile bez numeru zlecenia i bez załącznika.
  for (const ref of mail.threadRefs) {
    const loadId = threadLoadByRef.get(ref);
    if (loadId) return { relevant: true, matchedLoadId: loadId, reason: "odpowiedź w wątku znanego zlecenia" };
  }

  // 3) Załącznik PDF — kandydat na NOWE zlecenie od spedytora, którego jeszcze nie znamy.
  //
  // TYLKO TUTAJ działa reguła „czytaj wyłącznie oznaczone". Zakres jest wąski świadomie: oznaczenie
  // od pracownika mówi „to zlecenie jest DO WPISANIA", a więc dotyczy nowych zleceń. Gdyby objąć
  // nim także punkty 1-2, zniknąłby wcześniejszy wymóg właściciela — „nawet jak klient dośle
  // informacje w treści/dodatkowym to program to zobaczy" — bo odpowiedź spedytora w wątku nie
  // jest przez nikogo w firmie oznaczana.
  if (mail.attachments.length > 0) {
    if (!isMarked(mail, marking)) {
      return {
        relevant: false,
        matchedLoadId: null,
        reason: `mail z załącznikiem, ale bez oznaczenia „do wpisania" — pomijam${
          marking.categories.length > 0 ? ` (czekam na kategorię: ${marking.categories.join(", ")})` : ""
        }`,
      };
    }
    const oznaczenie = mail.categories.length > 0 ? mail.categories.join(", ") : "flaga";
    return {
      relevant: true,
      matchedLoadId: null,
      reason: `załącznik PDF (${mail.attachments.length})${marking.onlyMarked ? `, oznaczony: ${oznaczenie}` : ""}`,
    };
  }

  return { relevant: false, matchedLoadId: null, reason: "brak PDF-a, numeru zlecenia i powiązania z wątkiem" };
}
