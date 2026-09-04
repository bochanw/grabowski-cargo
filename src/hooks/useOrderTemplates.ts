"use client";

import { useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { planLearning, type LearningDocument } from "@/lib/orderTemplates/autoLearn";
import { learningDocsFromStored } from "@/lib/orderTemplates/fromStored";
import { loadToForm } from "@/lib/loads/loadToForm";
import type { OrderTemplate } from "@/types/orderTemplate";
import type { ParsedOrder } from "@/types/parsedOrder";
import type { LoadDocument } from "@/types/loadDocument";
import type { Load } from "@/types/load";

export const ORDER_TEMPLATES_QUERY_KEY = ["order-templates"] as const;

// Wzorzec dokumentu (`sample_text`) bywa kilkukilobajtowy, a lista szablonów wisi w pamięci przez
// cały czas pracy — do czytania dokumentów potrzebne są tylko reguły i odcisk układu. Pełny wiersz
// (z wzorcem) pobieramy dopiero w chwili nauki, dla JEDNEGO szablonu.
const LIST_COLUMNS =
  "id,label,forwarder_name,forwarder_nip,doc_kind,labels,rules,status,confirmations,uses,corrections,learned_from,created_at,updated_at,activated_at,last_used_at";

async function fetchOrderTemplates(): Promise<OrderTemplate[]> {
  const { data, error } = await supabase
    .from("order_templates")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({ ...row, sample_text: null, sample_values: null })) as OrderTemplate[];
}

/**
 * Nauczone szablony na żywo. Nazwa kanału z `useId()` — patrz useContractors: `supabase.channel()`
 * zwraca ISTNIEJĄCĄ instancję dla powtórzonej nazwy, a drugie `subscribe()` na niej rzuca wyjątek.
 */
export function useOrderTemplates() {
  const queryClient = useQueryClient();
  const channelId = useId();
  const query = useQuery({ queryKey: ORDER_TEMPLATES_QUERY_KEY, queryFn: fetchOrderTemplates });

  useEffect(() => {
    let subscribedBefore = false;
    const channel = supabase
      .channel(`order-templates-changes-${channelId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "order_templates" }, () => {
        // Świadomie bez `setQueryData` z ładunku zdarzenia: Realtime niesie CAŁY wiersz, więc
        // wpisanie go do cache wciągnęłoby do pamięci każdej przeglądarki wzorce wszystkich
        // szablonów. Lista jest krótka, a odświeżenie tanie.
        queryClient.invalidateQueries({ queryKey: ORDER_TEMPLATES_QUERY_KEY });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (subscribedBefore) queryClient.invalidateQueries({ queryKey: ORDER_TEMPLATES_QUERY_KEY });
          subscribedBefore = true;
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return query;
}

/** Wzorzec dokumentu dla JEDNEGO szablonu — pobierany dopiero w chwili nauki. */
async function withSample(template: OrderTemplate): Promise<OrderTemplate> {
  const { data, error } = await supabase
    .from("order_templates")
    .select("sample_text,sample_values")
    .eq("id", template.id)
    .single();
  if (error || !data) return template;
  return { ...template, sample_text: data.sample_text, sample_values: data.sample_values };
}

/**
 * Nauka po UDANYM zapisie zlecenia — z pól zatwierdzonych przez dyspozytora, nie z odpowiedzi
 * modelu.
 *
 * Zwraca komunikaty do pokazania, ale NIGDY nie rzuca: nauka jest dodatkiem, a nie warunkiem
 * zapisania zlecenia. Gdyby padła, dyspozytor ma mieć zapisane zlecenie i spokój.
 */
export function useLearnFromDocuments() {
  const queryClient = useQueryClient();

  return async function learn(documents: LearningDocument[], approved: ParsedOrder): Promise<string[]> {
    if (documents.length === 0) return [];
    const notes: string[] = [];
    try {
      const templates = (await fetchOrderTemplates()).slice();

      for (const document of documents) {
        const plan = planLearning(document, approved, templates);
        if (plan.kind === "none") continue;

        if (plan.kind === "insert") {
          const { data, error } = await supabase.from("order_templates").insert(plan.row).select(LIST_COLUMNS).single();
          if (error) continue;
          // Kolejny dokument z TEGO SAMEGO zapisu (np. list przewozowy obok zlecenia) ma widzieć
          // świeżo założony szablon — inaczej powstałyby dwa wiersze na ten sam układ.
          templates.push({ ...(data as OrderTemplate), sample_text: null, sample_values: null });
          notes.push(plan.note);
          continue;
        }

        const index = templates.findIndex((t) => t.id === plan.id);
        // Wzorzec doczytujemy dopiero tutaj i tylko dla tego jednego szablonu.
        const current = index >= 0 ? await withSample(templates[index]) : null;
        const replanned = current ? planLearning(document, approved, [current]) : plan;
        if (replanned.kind !== "update") continue;
        const { error } = await supabase.from("order_templates").update(replanned.patch).eq("id", replanned.id);
        if (error) continue;
        if (index >= 0) templates[index] = { ...templates[index], ...(replanned.patch as Partial<OrderTemplate>) };
        notes.push(replanned.note);
      }
    } catch {
      // Nauka nie może psuć zapisu zlecenia — po cichu odpuszczamy.
      return notes;
    }
    queryClient.invalidateQueries({ queryKey: ORDER_TEMPLATES_QUERY_KEY });
    return notes;
  };
}

export interface StoredLearningResult {
  /** Ile zleceń faktycznie coś wniosło do szablonów. */
  taught: number;
  /** Ile zleceń appka przejrzała, zanim skończyła (albo została zatrzymana). */
  seen: number;
  notes: string[];
  problems: string[];
}

/**
 * Nauka WSTECZ — z dokumentów leżących już przy zapisanych zleceniach.
 *
 * Ta sama nauka co przy zapisie zlecenia, tylko materiał pobierany z Storage zamiast z okna
 * (patrz src/lib/orderTemplates/fromStored.ts). Zlecenia przechodzą PO KOLEI, bo o tym, czy szablon
 * stanie się aktywny, decyduje para dokumentów tego samego układu: drugi musi zobaczyć wzorzec
 * zapisany przez pierwszy. Równolegle założyłyby dwa wiersze na ten sam układ.
 */
export function useLearnFromStoredDocuments() {
  const learnFromDocuments = useLearnFromDocuments();

  return async function run(
    items: { load: Load; documents: LoadDocument[] }[],
    onProgress?: (progress: { done: number; total: number; label: string }) => void,
    shouldStop?: () => boolean
  ): Promise<StoredLearningResult> {
    const result: StoredLearningResult = { taught: 0, seen: 0, notes: [], problems: [] };

    for (const item of items) {
      if (shouldStop?.()) break;
      const label = item.load.order_number ?? item.load.container_number ?? "zlecenie bez numeru";
      result.seen += 1;
      onProgress?.({ done: result.seen, total: items.length, label });

      const material = await learningDocsFromStored(item.documents);
      result.problems.push(...material.problems.map((p) => `${label}: ${p}`));
      if (material.documents.length === 0) continue;

      const notes = await learnFromDocuments(material.documents, loadToForm(item.load));
      if (notes.length === 0) continue;
      result.taught += 1;
      result.notes.push(`${label}: ${notes.join(" ")}`);
    }

    return result;
  };
}

export function useSetTemplateStatus() {
  const queryClient = useQueryClient();
  return async function setStatus(id: string, status: OrderTemplate["status"]): Promise<string | null> {
    const { error } = await supabase.from("order_templates").update({ status }).eq("id", id);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: ORDER_TEMPLATES_QUERY_KEY });
    return null;
  };
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return async function remove(id: string): Promise<string | null> {
    const { error } = await supabase.from("order_templates").delete().eq("id", id);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: ORDER_TEMPLATES_QUERY_KEY });
    return null;
  };
}
