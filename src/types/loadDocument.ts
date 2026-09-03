// Załącznik przy zleceniu — wiersz `public.load_documents` (migracja 0015). Plik leży w Storage,
// tu jest tylko metryka i ścieżka.
//
// Właściciel: oryginalne PDF-y ze zlecenia mają zostawać przy rekordzie, a dołożenie POD/CMR/
// potwierdzenia dostawy ma działać tak samo — z workiem "inne" na resztę.
export const DOCUMENT_KINDS = ["zlecenie", "list_przewozowy", "pod_cmr", "inne"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  zlecenie: "Zlecenie spedycyjne",
  list_przewozowy: "List przewozowy",
  pod_cmr: "POD / CMR / potwierdzenie dostawy",
  inne: "Inne",
};

export interface LoadDocument {
  id: string;
  load_id: string;
  kind: DocumentKind;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  /** Bucket Storage — dokument z maila zostaje w `order-emails`, wgrany ręcznie ląduje w `load-documents`. */
  bucket: string;
  storage_path: string;
  parse_source: string | null;
  uploaded_by: string | null;
  created_at: string;
}

/**
 * Rodzaj dokumentu zgadnięty z nazwy pliku i z tego, czym udało się go odczytać — tylko PROPOZYCJA,
 * przy każdym pliku jest lista do zmiany.
 *
 * Nazwy plików z systemów spedytorów sklejają słowa podkreśleniami i myślnikami
 * ("36729_Kontenerowy_list_przewozowy.pdf", "POD_podpisany.pdf"), więc separatory zamieniamy na
 * spacje PRZED dopasowaniem — bez tego `\b` i `\s` nie trafiają (podkreślenie jest znakiem słowa).
 */
export function guessDocumentKind(fileName: string, parseSource?: string | null): DocumentKind {
  const haystack = `${fileName} ${parseSource ?? ""}`.toLowerCase().replace(/[_\-.]+/g, " ");
  // CMR i POD idą razem — właściciel traktuje je jako jedną grupę "potwierdzenie dostawy".
  if (/\bpod\b|potwierdzenie|delivery note|proof of delivery|\bcmr\b/.test(haystack)) return "pod_cmr";
  if (/list przewozowy|waybill/.test(haystack)) return "list_przewozowy";
  if (/zlecenie|order|auftrag/.test(haystack)) return "zlecenie";
  return "inne";
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
