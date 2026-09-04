// ============================================================
// Co appka ma zrobić z dokumentem po zapisaniu zlecenia — czysta decyzja, bez dotykania bazy.
//
// Rozdzielone od zapisu celowo: reguła "kiedy szablon staje się aktywny" jest sercem oszczędności
// i musi dać się przetestować bez Supabase, na prawdziwych dokumentach.
//
// Kolejność stanów wprost z decyzji właściciela ("dopiero po drugim takim dokumencie"):
//   pierwszy dokument nowego układu  → zapamiętujemy WZORZEC (tekst + zatwierdzone pola),
//   drugi dokument tego układu       → wyprowadzamy kotwice z pary i, jeśli odtwarzają komplet
//                                      kluczowych pól, szablon staje się AKTYWNY,
//   kolejne dokumenty                → szablon się DOUCZA (pola, których w pierwszej parze nie
//                                      było, bo rubryki były puste) i jest pilnowany poprawkami.
// ============================================================

import { deriveRules } from "./learn";
import {
  applyRules,
  digitsOnly,
  documentLabels,
  guessDocKindFromText,
  labelSimilarity,
  missingKeyFields,
  SAME_LAYOUT_THRESHOLD,
  withIdentity,
  type DocKind,
  type LearnedField,
  type TemplateRules,
} from "./readTemplate";
import type { OrderTemplate } from "@/types/orderTemplate";
import type { ParsedOrder } from "@/types/parsedOrder";

/** Dokument bez etykiet nie ma po czym być rozpoznany — nie zakładamy dla niego szablonu. */
export const MIN_LABELS_TO_LEARN = 6;
/** Tyle poprawek dyspozytora na jednym polu i reguła wylatuje z szablonu. */
export const MAX_CORRECTIONS = 2;

export interface LearningDocument {
  text: string;
  fileName: string;
  /** Czym ten dokument został odczytany ("odczyt przez Claude", "ręcznie") — ląduje w `learned_from`. */
  source: string;
  /** Szablon, którym appka czytała TEN dokument, i co z niego wyszło — do liczenia poprawek. */
  usedTemplateId?: string;
  templateOutput?: ParsedOrder;
}

export type LearningOp =
  | { kind: "insert"; row: Record<string, unknown>; note: string }
  | { kind: "update"; id: string; patch: Record<string, unknown>; note: string }
  | { kind: "none"; note: string };

function kindLabel(kind: DocKind): string {
  return kind === "list_przewozowy" ? "list przewozowy" : kind === "zlecenie" ? "zlecenie" : "dokument";
}

function templateLabel(forwarder: string, kind: DocKind): string {
  return `${forwarder || "Nieznany spedytor"} — ${kindLabel(kind)} (nauczony)`;
}

/**
 * Szablon opisujący TEN układ dokumentu. Wycofanych nie wskrzeszamy — dyspozytor wyłączył je
 * świadomie i appka nie ma prawa tego cofać sama.
 */
export function findTemplateForDocument(
  templates: OrderTemplate[],
  document: { labels: string[]; docKind: DocKind; nip: string }
): OrderTemplate | null {
  let best: OrderTemplate | null = null;
  let bestScore = 0;
  for (const template of templates) {
    if (template.status === "wycofany") continue;
    if (template.doc_kind !== document.docKind) continue;
    const templateNip = digitsOnly(template.forwarder_nip);
    // Sprzeczne NIP-y = na pewno inny spedytor. Brak NIP-u po którejś stronie niczemu nie przeczy.
    if (templateNip.length >= 9 && document.nip.length >= 9 && templateNip !== document.nip) continue;
    const score = labelSimilarity(document.labels, template.labels);
    if (score < SAME_LAYOUT_THRESHOLD || score <= bestScore) continue;
    best = template;
    bestScore = score;
  }
  return best;
}

/** Które pola dyspozytor poprawił po tym, jak odczytał je szablon. */
function countCorrections(
  template: OrderTemplate,
  templateOutput: ParsedOrder,
  approved: ParsedOrder
): { corrections: Record<string, number>; corrected: LearnedField[] } {
  const corrections: Record<string, number> = { ...template.corrections };
  const corrected: LearnedField[] = [];
  for (const field of Object.keys(template.rules) as LearnedField[]) {
    const read = templateOutput[field];
    const saved = approved[field];
    // Puste pole to nie pomyłka szablonu, tylko brak w dokumencie; liczy się tylko odczyt ZŁY.
    if (read === null || read === undefined || read === "") continue;
    if (String(read).trim() === String(saved ?? "").trim()) continue;
    corrections[field] = (corrections[field] ?? 0) + 1;
    corrected.push(field);
  }
  return { corrections, corrected };
}

function dropCorrectedRules(rules: TemplateRules, corrections: Record<string, number>): TemplateRules {
  const out: TemplateRules = {};
  for (const [field, rule] of Object.entries(rules) as [LearnedField, TemplateRules[LearnedField]][]) {
    if ((corrections[field] ?? 0) >= MAX_CORRECTIONS) continue;
    out[field] = rule;
  }
  return out;
}

/**
 * Co zrobić z tym dokumentem: założyć szablon, potwierdzić go, douczyć albo nic.
 *
 * `approved` to pola ZAPISANEGO zlecenia — czyli to, co dyspozytor zatwierdził. Uczymy się z nich,
 * nie z odpowiedzi modelu.
 */
export function planLearning(
  document: LearningDocument,
  approved: ParsedOrder,
  templates: OrderTemplate[]
): LearningOp {
  const labels = documentLabels(document.text);
  if (document.text.trim().length < 300 || labels.length < MIN_LABELS_TO_LEARN) {
    return { kind: "none", note: `${document.fileName}: za mało etykiet, żeby rozpoznać układ — bez nauki.` };
  }

  const docKind = guessDocKindFromText(document.text);
  const nip = digitsOnly(approved.forwarder_nip);
  const used = document.usedTemplateId ? templates.find((t) => t.id === document.usedTemplateId) ?? null : null;
  const existing = used ?? findTemplateForDocument(templates, { labels, docKind, nip });

  // 1. Nowy układ — zapamiętujemy sam wzorzec. Reguł jeszcze nie ma i nie może być: z jednego
  //    dokumentu nie da się odróżnić etykiety od wartości sąsiedniej rubryki.
  if (!existing) {
    return {
      kind: "insert",
      row: {
        label: templateLabel(approved.forwarder, docKind),
        forwarder_name: approved.forwarder || null,
        forwarder_nip: nip || null,
        doc_kind: docKind,
        labels,
        rules: {},
        status: "kandydat",
        confirmations: 1,
        sample_text: document.text,
        sample_values: approved,
        learned_from: document.source,
      },
      note: `Zapamiętałem układ dokumentu (${approved.forwarder || "nieznany spedytor"}). Przy kolejnym takim ${kindLabel(docKind)} appka nauczy się go czytać sama.`,
    };
  }

  const patch: Record<string, unknown> = { confirmations: existing.confirmations + 1, labels };
  let corrections = existing.corrections ?? {};
  let corrected: LearnedField[] = [];
  if (used && document.templateOutput) {
    const counted = countCorrections(existing, document.templateOutput, approved);
    corrections = counted.corrections;
    corrected = counted.corrected;
    patch.uses = (existing.uses ?? 0) + 1;
    patch.last_used_at = new Date().toISOString();
  }

  // 2. Mamy wzorzec i drugi dokument tego układu — wyprowadzamy kotwice z pary.
  const sample = existing.sample_text && existing.sample_values
    ? { text: existing.sample_text, values: existing.sample_values }
    : null;
  const derived = sample ? deriveRules(sample, { text: document.text, values: approved }) : {};

  // Reguły, które już działają, zostają; z pary dokładamy tylko to, czego szablon jeszcze nie zna.
  // Odwrotna kolejność (nowe nadpisują stare) kasowałaby regułę sprawdzoną na wielu dokumentach
  // na rzecz świeżej, opartej na jednej parze.
  const merged: TemplateRules = { ...derived, ...existing.rules };
  const rules = dropCorrectedRules(merged, corrections);
  const parsed = withIdentity(applyRules(document.text, rules), existing);
  const missing = missingKeyFields(parsed, existing.doc_kind);

  patch.rules = rules;
  patch.corrections = corrections;

  if (missing.length === 0) {
    // 3. Szablon czyta komplet kluczowych pól — od teraz zastępuje płatny odczyt.
    const activating = existing.status !== "aktywny";
    patch.status = "aktywny";
    if (activating) patch.activated_at = new Date().toISOString();
    if (!existing.forwarder_name && approved.forwarder) patch.forwarder_name = approved.forwarder;
    if (!existing.forwarder_nip && nip) patch.forwarder_nip = nip;
    return {
      kind: "update",
      id: existing.id,
      patch,
      note: activating
        ? `Nauczyłem się układu: ${existing.label}. Kolejne dokumenty tego spedytora appka odczyta sama, bez płatnego odczytu.`
        : corrected.length > 0
          ? `Szablon "${existing.label}" poprawiony po Twoich zmianach (${corrected.join(", ")}).`
          : `Szablon "${existing.label}" douczony (${Object.keys(rules).length} pól).`,
    };
  }

  // 4. Za mało pól, żeby szablon wystarczał sam. Wzorcem zostaje NOWSZY dokument: skoro poprzednia
  //    para nie dała kompletu, kolejna próba ma szansę tylko z inną parą.
  patch.status = existing.status === "aktywny" ? "kandydat" : existing.status;
  patch.sample_text = document.text;
  patch.sample_values = approved;
  return {
    kind: "update",
    id: existing.id,
    patch,
    note:
      existing.status === "aktywny"
        ? `Szablon "${existing.label}" przestał odczytywać komplet pól (${missing.join(", ")}) — wraca do nauki, dokumenty znów czyta Claude.`
        : `Szablon "${existing.label}" jeszcze się uczy — brakuje: ${missing.join(", ")}.`,
  };
}
