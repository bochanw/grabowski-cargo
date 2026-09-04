"use client";

import { useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import { signedStorageUrl } from "@/lib/supabase/storageUrl";
import type { DocumentKind, LoadDocument } from "@/types/loadDocument";

export const LOAD_DOCUMENTS_QUERY_KEY = ["load_documents"] as const;

const BUCKET = "load-documents";
/** Ile trzyma podpisany URL do podglądu pliku — tyle, żeby dało się otworzyć i przeczytać. */
const SIGNED_URL_SECONDS = 60 * 60;

async function fetchLoadDocuments(): Promise<LoadDocument[]> {
  // Wszystkie naraz, nie per zlecenie: dokumentów jest kilka na zlecenie, a licznik "Dokumenty (N)"
  // przy każdym wierszu i tak potrzebuje kompletu. Jedno zapytanie i jeden kanał Realtime zamiast
  // zapytania per wiersz tabeli.
  const { data, error } = await supabase
    .from("load_documents")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Załączniki zleceń na żywo. Ten sam wzorzec co useLoads/useContractors — Realtime → setQueryData,
 * nazwa kanału z `useId()` (powtórzona nazwa = wyjątek przy drugim subscribe, patrz CLAUDE.md).
 */
export function useLoadDocuments() {
  const queryClient = useQueryClient();
  const channelId = useId();
  const query = useQuery({ queryKey: LOAD_DOCUMENTS_QUERY_KEY, queryFn: fetchLoadDocuments });

  useEffect(() => {
    let subscribedBefore = false;
    const channel = supabase
      .channel(`load-documents-changes-${channelId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "load_documents" }, (payload) => {
        queryClient.setQueryData<LoadDocument[]>(LOAD_DOCUMENTS_QUERY_KEY, (current) => {
          if (!current) return current;
          if (payload.eventType === "INSERT") {
            const row = payload.new as LoadDocument;
            return current.some((d) => d.id === row.id) ? current : [...current, row];
          }
          if (payload.eventType === "UPDATE") {
            const row = payload.new as LoadDocument;
            return current.map((d) => (d.id === row.id ? row : d));
          }
          if (payload.eventType === "DELETE") {
            const id = (payload.old as Partial<LoadDocument>).id;
            return current.filter((d) => d.id !== id);
          }
          return current;
        });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (subscribedBefore) queryClient.invalidateQueries({ queryKey: LOAD_DOCUMENTS_QUERY_KEY });
          subscribedBefore = true;
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return query;
}

// Nazwa pliku w Storage: bez polskich znaków, spacji i ukośników (klucz obiektu to ścieżka), ale
// czytelna — przy grzebaniu w buckecie widać, co to za dokument. Oryginalna nazwa i tak zostaje w
// kolumnie `file_name`.
function safeFileName(name: string): string {
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80) || "dokument.pdf";
}

export interface UploadDocumentInput {
  loadId: string;
  file: File;
  kind: DocumentKind;
  parseSource?: string | null;
}

/**
 * Wgranie pliku do Storage + wiersz w `load_documents`. Zwraca komunikat błędu albo null.
 *
 * Kolejność ma znaczenie: najpierw plik, potem wiersz. Wiersz bez pliku byłby martwym linkiem w UI,
 * a plik bez wiersza to tylko śmieć w buckecie (kasowany przy najbliższym sprzątaniu).
 */
export function useUploadLoadDocument() {
  const queryClient = useQueryClient();

  return async function uploadDocument({ loadId, file, kind, parseSource }: UploadDocumentInput): Promise<string | null> {
    const path = `${loadId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, {
      contentType: file.type || "application/pdf",
      upsert: false,
    });
    if (uploadError) return uploadError.message;

    const { data: sessionData } = await supabase.auth.getSession();
    const { error } = await supabase.from("load_documents").insert({
      load_id: loadId,
      kind,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      bucket: BUCKET,
      storage_path: path,
      parse_source: parseSource ?? null,
      uploaded_by: sessionData.session?.user?.email ?? null,
    });
    if (error) {
      // Wiersz się nie zapisał — plik zostaje osierocony, więc sprzątamy od razu.
      await supabase.storage.from(BUCKET).remove([path]);
      return error.message;
    }
    queryClient.invalidateQueries({ queryKey: LOAD_DOCUMENTS_QUERY_KEY });
    return null;
  };
}

/** Podpięcie pliku, który JUŻ leży w Storage (załącznik maila w `order-emails`) — bez kopiowania. */
export function useLinkExistingDocument() {
  const queryClient = useQueryClient();

  return async function linkDocument(input: {
    loadId: string;
    bucket: string;
    storagePath: string;
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    kind: DocumentKind;
    parseSource?: string | null;
  }): Promise<string | null> {
    const { data: sessionData } = await supabase.auth.getSession();
    const { error } = await supabase.from("load_documents").insert({
      load_id: input.loadId,
      kind: input.kind,
      file_name: input.fileName,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      bucket: input.bucket,
      storage_path: input.storagePath,
      parse_source: input.parseSource ?? null,
      uploaded_by: sessionData.session?.user?.email ?? null,
    });
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: LOAD_DOCUMENTS_QUERY_KEY });
    return null;
  };
}

export function useUpdateLoadDocument() {
  const queryClient = useQueryClient();
  return async function updateDocument(id: string, patch: Partial<Pick<LoadDocument, "kind">>): Promise<string | null> {
    const { error } = await supabase.from("load_documents").update(patch).eq("id", id);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: LOAD_DOCUMENTS_QUERY_KEY });
    return null;
  };
}

/**
 * Kasowanie: najpierw wiersz, potem plik. Plik z bucketa maili (`order-emails`) ZOSTAJE — tam jest
 * oryginał wiadomości, a my kasujemy tylko podpięcie do zlecenia.
 */
export function useDeleteLoadDocument() {
  const queryClient = useQueryClient();
  return async function deleteDocument(document: LoadDocument): Promise<string | null> {
    const { error } = await supabase.from("load_documents").delete().eq("id", document.id);
    if (error) return error.message;
    if (document.bucket === BUCKET) {
      await supabase.storage.from(BUCKET).remove([document.storage_path]);
    }
    queryClient.invalidateQueries({ queryKey: LOAD_DOCUMENTS_QUERY_KEY });
    return null;
  };
}

/** Podpisany URL do otwarcia pliku w nowej karcie (bucket jest prywatny). */
export async function signedDocumentUrl(document: LoadDocument): Promise<{ url: string } | { error: string }> {
  return signedStorageUrl(document.bucket, document.storage_path, SIGNED_URL_SECONDS);
}

/**
 * Sprzątanie plików przy kasowaniu zlecenia. Wiersze znikną same (`on delete cascade`), ale pliki w
 * Storage nie — Postgres do niego nie sięga, więc bez tego bucket puchłby o osierocone dokumenty.
 */
export async function removeStoredFilesForLoad(loadId: string): Promise<void> {
  const { data } = await supabase.from("load_documents").select("bucket, storage_path").eq("load_id", loadId);
  const paths = (data ?? []).filter((d) => d.bucket === BUCKET).map((d) => d.storage_path as string);
  if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths);
}
