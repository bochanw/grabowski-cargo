"use client";

import { useState } from "react";
import { useDeleteTemplate, useOrderTemplates, useSetTemplateStatus } from "@/hooks/useOrderTemplates";
import { DOC_KIND_LABELS, TEMPLATE_STATUS_LABELS, type OrderTemplate } from "@/types/orderTemplate";
import { COLUMNS } from "./columns";

// Nauczone szablony — układy dokumentów, których appka nauczyła się sama z zapisanych zleceń
// (src/lib/orderTemplates/learn.ts). To okno istnieje po to, żeby auto-nauka nie była magią:
// dyspozytor widzi, CO appka rozpoznaje, ile razy tego użyła, ile razy musiał ją poprawić — i może
// każdy szablon wyłączyć albo skasować. Wyłączonego appka nie wskrzesza sama.

const STATUS_STYLE: Record<OrderTemplate["status"], string> = {
  aktywny: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  kandydat: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  wycofany: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

// Etykiety kolumn Zestawienia — nazwy pól z reguł mają być czytelne dla dyspozytora, nie techniczne.
const FIELD_LABELS: Record<string, string> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—";
}

export function OrderTemplatesDialog({ onClose }: { onClose: () => void }) {
  const { data: templates = [], isLoading, isError, error } = useOrderTemplates();
  const setStatus = useSetTemplateStatus();
  const deleteTemplate = useDeleteTemplate();
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function toggle(template: OrderTemplate) {
    const next = template.status === "wycofany" ? "kandydat" : "wycofany";
    const err = await setStatus(template.id, next);
    setMessage(
      err
        ? `Nie udało się zmienić: ${err}`
        : next === "wycofany"
          ? `Szablon „${template.label}" wyłączony — te dokumenty znów będzie czytał Claude.`
          : `Szablon „${template.label}" wraca do nauki — potwierdzi go najbliższy dokument tego układu.`
    );
  }

  async function remove(template: OrderTemplate) {
    if (!window.confirm(`Usunąć szablon „${template.label}"? Appka nauczy się go od nowa przy kolejnych dwóch dokumentach.`)) return;
    const err = await deleteTemplate(template.id);
    setMessage(err ? `Nie udało się usunąć: ${err}` : `Szablon „${template.label}" usunięty.`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Nauczone szablony dokumentów</h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Pierwsze zlecenie od nowego spedytora czyta Claude (płatnie). Appka zapamiętuje wtedy układ
          dokumentu, a przy drugim takim dokumencie uczy się go czytać sama — od tej chwili kolejne
          zlecenia tego spedytora są odczytywane za darmo.
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {isLoading && <p className="text-xs text-zinc-500">Wczytywanie…</p>}
          {isError && (
            <p className="text-xs text-red-600">Nie udało się wczytać: {error instanceof Error ? error.message : String(error)}</p>
          )}
          {!isLoading && !isError && templates.length === 0 && (
            <p className="text-xs text-zinc-500">
              Jeszcze nic — appka zapamięta pierwszy układ przy najbliższym zapisanym zleceniu z PDF-em.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {templates.map((template) => {
              const fields = Object.keys(template.rules);
              const corrected = Object.entries(template.corrections ?? {}).filter(([, count]) => count > 0);
              return (
                <div key={template.id} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[template.status]}`}>
                      {TEMPLATE_STATUS_LABELS[template.status]}
                    </span>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{template.label}</span>
                    <span className="text-xs text-zinc-500">{DOC_KIND_LABELS[template.doc_kind]}</span>
                    {template.forwarder_nip && <span className="text-xs text-zinc-400">NIP {template.forwarder_nip}</span>}
                    <div className="ml-auto flex gap-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === template.id ? null : template.id)}
                        className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
                      >
                        {expanded === template.id ? "Zwiń" : "Co czyta"}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggle(template)}
                        className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
                      >
                        {template.status === "wycofany" ? "Włącz" : "Wyłącz"}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(template)}
                        className="rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:border-red-400 dark:border-red-900"
                      >
                        Usuń
                      </button>
                    </div>
                  </div>

                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {template.status === "kandydat"
                      ? "Ma wzorzec, czeka na drugi taki dokument, żeby nauczyć się kotwic."
                      : `Czyta ${fields.length} pól`}
                    {" · "}dokumentów: {template.confirmations}
                    {" · "}użyć: {template.uses}
                    {" · "}ostatnio: {formatDate(template.last_used_at)}
                    {template.learned_from ? ` · z: ${template.learned_from}` : ""}
                  </p>

                  {corrected.length > 0 && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">
                      Poprawiane przez dyspozytora: {corrected.map(([f, n]) => `${fieldLabel(f)} (${n}×)`).join(", ")}
                      {corrected.some(([, n]) => n >= 2) ? " — te pola appka przestała już czytać z szablonu." : ""}
                    </p>
                  )}

                  {expanded === template.id && (
                    <div className="mt-2 rounded bg-zinc-50 p-2 dark:bg-zinc-900">
                      {fields.length === 0 ? (
                        <p className="text-xs text-zinc-500">Brak reguł — szablon dopiero czeka na drugi dokument.</p>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {fields.map((field) => {
                            const rule = template.rules[field as keyof typeof template.rules]!;
                            return (
                              <li key={field} className="text-xs text-zinc-600 dark:text-zinc-300">
                                <span className="font-medium">{fieldLabel(field)}</span>: między „
                                <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">{rule.before.trim()}</code>" a „
                                <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">{rule.after.trim() || "spacja"}</code>"
                                {rule.occurrence ? ` (${rule.occurrence + 1}. z kolei)` : ""}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {message && (
          <div className="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">{message}</div>
        )}
      </div>
    </div>
  );
}
