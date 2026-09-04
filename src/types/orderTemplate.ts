import type { DocKind, TemplateRules } from "@/lib/orderTemplates/readTemplate";
import type { ParsedOrder } from "@/types/parsedOrder";

/**
 * Nauczony szablon dokumentu — wiersz tabeli `order_templates` (migracja 0023).
 *
 * Kształt `rules` zna wyłącznie appka (src/lib/orderTemplates/learn.ts); baza trzyma go jako jsonb
 * i niczego nie waliduje — ten sam wzorzec co przy `user_view_settings`, żeby ulepszenie reguł nie
 * wymagało migracji.
 */
export interface OrderTemplate {
  id: string;
  label: string;
  forwarder_name: string | null;
  forwarder_nip: string | null;
  doc_kind: DocKind;
  labels: string[];
  rules: TemplateRules;
  status: "kandydat" | "aktywny" | "wycofany";
  /** Ile dokumentów potwierdziło ten układ (1 = dopiero wzorzec, 2+ = szablon działa). */
  confirmations: number;
  uses: number;
  /** pole → ile razy dyspozytor poprawił to, co odczytał szablon. */
  corrections: Record<string, number>;
  sample_text: string | null;
  sample_values: ParsedOrder | null;
  learned_from: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  last_used_at: string | null;
}

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  zlecenie: "zlecenie",
  list_przewozowy: "list przewozowy",
  inne: "dokument",
};

export const TEMPLATE_STATUS_LABELS: Record<OrderTemplate["status"], string> = {
  kandydat: "uczy się",
  aktywny: "działa",
  wycofany: "wyłączony",
};
