"use client";

// ============================================================
// Nauka z dokumentów, które JUŻ leżą przy zleceniu — obejście na czas rozruchu.
//
// Po co: zwykła auto-nauka rusza przy zapisie zlecenia w oknie (patrz autoLearn.ts), bo dopiero tam
// appka ma naraz tekst dokumentu i pola zatwierdzone przez człowieka. Zlecenia odczytane wcześniej
// przez Claude są już zapisane, a ich PDF-y przyszły mailem i leżą w Storage — wgrywanie ich
// jeszcze raz z dysku po to, żeby appka je "zobaczyła", byłoby przepisywaniem tego, co i tak ma.
//
// Ten moduł pobiera te pliki z powrotem, wyciąga z nich tekst tą SAMĄ ścieżką co okno importu
// (pdf.js w przeglądarce) i oddaje `LearningDocument[]` — dalej idzie dokładnie ta sama nauka.
// Wartościami "zatwierdzonymi" jest wtedy zapisany rekord, czyli także poprawki wpisane w tabeli.
// ============================================================

import { supabase } from "@/lib/supabase/client";
import { extractPdfText } from "@/lib/pdf/extractPdfText";
import type { LearningDocument } from "./autoLearn";
import type { LoadDocument } from "@/types/loadDocument";

/**
 * POD/CMR/potwierdzenie dostawy do nauki NIE idą: to nie są zlecenia, więc szablon z nich nigdy nie
 * odtworzy kompletu kluczowych pól — założyłyby tylko wieczne "kandydaty" zaśmiecające listę.
 */
const SKIPPED_KINDS: LoadDocument["kind"][] = ["pod_cmr"];

/** Plik leżący w Storage — bez znaczenia, czy podpięty do zlecenia, czy przyszedł mailem. */
export interface StoredFileRef {
  bucket: string;
  path: string;
  fileName: string;
  mimeType?: string | null;
  /** Czym go kiedyś odczytano — trafia do `learned_from` szablonu. */
  parseSource?: string | null;
}

function isPdf(file: StoredFileRef): boolean {
  if (file.mimeType) return file.mimeType.includes("pdf");
  return /\.pdf$/i.test(file.fileName || file.path);
}

export interface StoredLearningMaterial {
  documents: LearningDocument[];
  /** Czego nie dało się wykorzystać i dlaczego — do pokazania, nie do zjedzenia po cichu. */
  problems: string[];
}

/** Pliki z Storage → materiał do nauki. Tekst wyciągany tą samą ścieżką co w oknie importu. */
export async function learningDocsFromStorage(files: StoredFileRef[]): Promise<StoredLearningMaterial> {
  const out: LearningDocument[] = [];
  const problems: string[] = [];

  for (const document of files) {
    const name = document.fileName || document.path;
    if (!isPdf(document)) {
      problems.push(`${name}: to nie PDF — pomijam.`);
      continue;
    }

    const { data, error } = await supabase.storage.from(document.bucket).download(document.path);
    if (error || !data) {
      problems.push(`${name}: nie udało się pobrać pliku (${error?.message ?? "brak danych"}).`);
      continue;
    }

    let text = "";
    try {
      text = await extractPdfText(new File([data], name, { type: document.mimeType ?? "application/pdf" }));
    } catch (err) {
      problems.push(`${name}: nie udało się odczytać tekstu (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    // Skan bez warstwy tekstowej — nauka na kotwicach tekstowych nie ma z czego powstać. To nie
    // błąd, tylko granica metody; Claude czyta takie dokumenty dalej.
    if (text.trim().length < 300) {
      problems.push(`${name}: brak warstwy tekstowej (skan?) — z tego appka się nie nauczy.`);
      continue;
    }

    out.push({
      text,
      fileName: name,
      source: document.parseSource || "dokument z Storage",
      // Świadomie BEZ `usedTemplateId`/`templateOutput`: ten dokument był czytany kiedyś i czymś
      // innym, więc liczenie "poprawek dyspozytora" byłoby liczeniem cudzych pomyłek.
    });
  }

  return { documents: out, problems };
}

/**
 * Dokumenty jednego zlecenia → materiał do nauki. Bucket bierzemy z wiersza: załącznik z maila
 * zostaje w `order-emails` (Skrzynka go tylko podpina), wgrany ręcznie leży w `load-documents`.
 */
export async function learningDocsFromStored(documents: LoadDocument[]): Promise<StoredLearningMaterial> {
  return learningDocsFromStorage(
    documents
      .filter((document) => !SKIPPED_KINDS.includes(document.kind))
      .map((document) => ({
        bucket: document.bucket,
        path: document.storage_path,
        fileName: document.file_name ?? document.storage_path,
        mimeType: document.mime_type,
        parseSource: document.parse_source
          ? `${document.parse_source} (nauka z zapisanego zlecenia)`
          : "nauka z zapisanego zlecenia",
      }))
  );
}
