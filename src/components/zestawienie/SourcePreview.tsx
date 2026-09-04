"use client";

import { useEffect, useState } from "react";
import { signedStorageUrl } from "@/lib/supabase/storageUrl";

/**
 * ŹRÓDŁO, z którego wzięły się pola zlecenia — oryginalny PDF albo treść maila, pokazane OBOK
 * formularza.
 *
 * Zgłoszenie właściciela wprost: "odczytując zlecenia z maila nie widzę źródła — więc nie jestem
 * w stanie skorygować błędów". Odczyt (szablon albo model) bywa nietrafiony, a bez dokumentu pod
 * ręką dyspozytor nie ma jak sprawdzić, czy "1450" to stawka, czy numer rubryki obok. Dlatego to
 * NIE jest osobne okno: dokument i pola muszą być widoczne JEDNOCZEŚNIE, inaczej poprawianie
 * sprowadza się do przepisywania z pamięci.
 */
export interface SourceItem {
  id: string;
  label: string;
  /** "pdf" idzie do ramki podglądu, "text" (treść maila) wyświetlamy wprost. */
  kind: "pdf" | "text";
  /** Plik wybrany w tym oknie — podgląd z pamięci przeglądarki, bez pobierania czegokolwiek. */
  file?: File;
  /** Plik już w Storage (załącznik maila w `order-emails`) — bucket prywatny, potrzebny podpis. */
  bucket?: string;
  path?: string;
  text?: string;
  /** Czym to odczytano albo dlaczego nie — ta sama informacja co przy załączniku w Skrzynce. */
  note?: string;
}

export function SourcePreview({ items, onClose }: { items: SourceItem[]; onClose?: () => void }) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? "");
  const active = items.find((item) => item.id === activeId) ?? items[0];
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Jedno źródło URL-a na dwa różne miejsca pochodzenia pliku: lokalny wybór (obiekt w pamięci)
  // i Storage (podpisany link). `revoke` jest konieczne — bez niego każde przełączenie dokumentu
  // zostawiałoby w pamięci karty kopię PDF-a.
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);

    if (active?.kind === "pdf") {
      if (active.file) {
        objectUrl = URL.createObjectURL(active.file);
        setUrl(objectUrl);
      } else if (active.bucket && active.path) {
        void signedStorageUrl(active.bucket, active.path).then((result) => {
          if (cancelled) return;
          if ("error" in result) setError(result.error);
          else setUrl(result.url);
        });
      } else {
        setError("Brak pliku do podglądu.");
      }
    }

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active?.id, active?.kind, active?.file, active?.bucket, active?.path]);

  if (items.length === 0) return null;

  return (
    <aside
      data-testid="zrodlo"
      className="flex min-h-0 w-full flex-col rounded border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        <span className="mr-1 text-xs font-semibold text-zinc-700 dark:text-zinc-200">Źródło</span>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid="zrodlo-zakladka"
            onClick={() => setActiveId(item.id)}
            title={item.note ?? undefined}
            className={`max-w-[12rem] truncate rounded border px-2 py-0.5 text-[11px] ${
              item.id === active?.id
                ? "border-zinc-900 bg-white font-medium text-zinc-900 dark:border-zinc-100 dark:bg-zinc-950 dark:text-zinc-50"
                : "border-zinc-300 text-zinc-600 hover:bg-white dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-950"
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {url && (
            // Ramka bywa za mała na drobny druk, a niektóre przeglądarki mają wyłączony wbudowany
            // czytnik PDF — wtedy to jedyna droga do dokumentu.
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-blue-700 underline dark:text-blue-300"
            >
              Otwórz w nowej karcie
            </a>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Ukryj źródło"
              className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              ✕
            </button>
          )}
        </span>
      </div>

      {active?.note && (
        <div className="border-b border-zinc-200 px-2 py-1 text-[11px] text-zinc-500 dark:border-zinc-800">
          {active.note}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {active?.kind === "text" ? (
          <pre className="whitespace-pre-wrap break-words p-2 text-[11px] leading-snug text-zinc-800 dark:text-zinc-200">
            {active.text?.trim() || "(pusta treść)"}
          </pre>
        ) : error ? (
          <p className="p-2 text-[11px] text-red-600 dark:text-red-400">Nie udało się pokazać pliku: {error}</p>
        ) : url ? (
          <iframe data-testid="zrodlo-ramka" src={url} title={active?.label ?? "Dokument"} className="h-full w-full" />
        ) : (
          <p className="p-2 text-[11px] text-zinc-500">Wczytywanie dokumentu…</p>
        )}
      </div>
    </aside>
  );
}
