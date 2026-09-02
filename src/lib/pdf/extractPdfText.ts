"use client";

import * as pdfjsLib from "pdfjs-dist";

let workerConfigured = false;

function ensureWorker() {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();
  workerConfigured = true;
}

/**
 * Wyciąga cały tekst PDF-a po stronie przeglądarki (pdf.js) — potrzebne pod parsery znanych
 * szablonów zleceń (src/lib/orderTemplates/), które działają na samym tekście, bez wysyłania
 * pliku gdziekolwiek. Kolejność elementów w warstwie tekstowej pdf.js zwykle odpowiada kolejności
 * czytania dokumentu (zweryfikowane na przykładowym zleceniu Q4Road), ale to nie jest gwarancja
 * dla KAŻDEGO PDF-a — parsery szablonów muszą być odporne na drobne przetasowania, nie zakładać
 * sztywnych pozycji.
 */
export async function extractPdfText(file: File): Promise<string> {
  ensureWorker();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pageTexts.push(pageText);
  }
  return pageTexts.join(" ").replace(/\s+/g, " ").trim();
}
