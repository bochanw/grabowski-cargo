"use client";

import { useRef, useState } from "react";
import {
  signedDocumentUrl,
  useDeleteLoadDocument,
  useLoadDocuments,
  useUpdateLoadDocument,
  useUploadLoadDocument,
} from "@/hooks/useLoadDocuments";
import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  formatFileSize,
  guessDocumentKind,
  type DocumentKind,
  type LoadDocument,
} from "@/types/loadDocument";
import type { Load } from "@/types/load";

const DATE_FORMATTER = new Intl.DateTimeFormat("pl-PL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Dokumenty jednego zlecenia: oryginały PDF zapisane przy imporcie plus wszystko, co dochodzi
 * później — POD, CMR, potwierdzenie dostawy, „inne" (właściciel: "analogicznie jak dogram
 * POD/CMR/potwierdzenie dostawy program będzie dodawać także pole inne").
 *
 * To okno tylko PRZECHOWUJE pliki — nie czyta z nich pól. Odczyt (i uzupełnianie brakujących pól)
 * siedzi w oknie „Nowe zlecenie / Dopnij PDF", które rozpoznaje zlecenie po numerze.
 */
export function LoadDocumentsDialog({ load, onClose }: { load: Load; onClose: () => void }) {
  const { data: allDocuments = [], isLoading, isError, error } = useLoadDocuments();
  const uploadDocument = useUploadLoadDocument();
  const updateDocument = useUpdateLoadDocument();
  const deleteDocument = useDeleteLoadDocument();
  const [kind, setKind] = useState<DocumentKind>("pod_cmr");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const documents = allDocuments.filter((d) => d.load_id === load.id);

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setBusy(true);
    setMessage(null);
    const failures: string[] = [];
    for (const file of files) {
      // Rodzaj z listy obok jest DOMYŚLNY dla całej wgranej paczki; jeśli nazwa pliku mówi coś
      // innego wprost ("CMR", "list przewozowy"), wierzymy nazwie — i tak da się to zmienić listą
      // przy każdym wierszu poniżej.
      const guessed = guessDocumentKind(file.name);
      const error = await uploadDocument({ loadId: load.id, file, kind: guessed === "inne" ? kind : guessed });
      if (error) failures.push(`${file.name}: ${error}`);
    }
    setBusy(false);
    setMessage(failures.length > 0 ? `Nie udało się wgrać: ${failures.join("; ")}` : `Dodano ${files.length} dokument(y).`);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function open(document: LoadDocument) {
    setMessage(null);
    const result = await signedDocumentUrl(document);
    if ("error" in result) {
      setMessage(`Nie udało się otworzyć pliku: ${result.error}`);
      return;
    }
    window.open(result.url, "_blank", "noopener");
  }

  async function remove(document: LoadDocument) {
    if (!window.confirm(`Usunąć dokument ${document.file_name ?? ""} z tego zlecenia?`)) return;
    const error = await deleteDocument(document);
    if (error) setMessage(`Nie udało się usunąć: ${error}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Dokumenty — zlecenie {load.order_number ?? "(bez numeru)"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {message && (
            <p className="mb-3 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              {message}
            </p>
          )}

          {isLoading && !isError && <p className="text-xs text-zinc-500">Wczytywanie…</p>}
          {/* Nieudany odczyt musi być widoczny — inaczej okno wisiałoby na „Wczytywanie…" i
              wyglądało jak zlecenie bez dokumentów. */}
          {isError && (
            <p className="text-xs text-red-600">
              Nie udało się wczytać dokumentów: {error instanceof Error ? error.message : String(error)}
            </p>
          )}
          {!isLoading && !isError && documents.length === 0 && (
            <p className="text-xs text-zinc-500">
              Brak dokumentów przy tym zleceniu. PDF-y wgrane przy imporcie zapisują się tutaj same;
              POD, CMR i potwierdzenia dostawy dodasz poniżej.
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {documents.map((document) => (
              <li
                key={document.id}
                className="flex items-center gap-2 rounded border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                    {document.file_name ?? "(bez nazwy)"}
                  </div>
                  <div className="text-zinc-500">
                    {formatFileSize(document.size_bytes)}
                    {document.size_bytes ? " · " : ""}
                    {DATE_FORMATTER.format(new Date(document.created_at))}
                    {document.uploaded_by ? ` · ${document.uploaded_by}` : ""}
                    {document.parse_source ? ` · odczytano: ${document.parse_source}` : ""}
                  </div>
                </div>
                <select
                  value={document.kind}
                  onChange={(e) => void updateDocument(document.id, { kind: e.target.value as DocumentKind })}
                  className="rounded border border-zinc-300 px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                >
                  {DOCUMENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {DOCUMENT_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void open(document)}
                  className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  Otwórz
                </button>
                <button
                  type="button"
                  onClick={() => void remove(document)}
                  className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
                >
                  Usuń
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 px-4 py-4 dark:border-zinc-700">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as DocumentKind)}
              className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DOCUMENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy ? "Wgrywanie…" : "Dodaj dokument"}
            </button>
            <span className="text-xs text-zinc-500">PDF, skan, zdjęcie — cokolwiek dojdzie do tego zlecenia.</span>
            <input ref={inputRef} type="file" multiple onChange={(e) => void handleFiles(e.target.files)} className="hidden" />
          </div>
        </div>

        <div className="flex justify-end border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
            Zamknij
          </button>
        </div>
      </div>
    </div>
  );
}
