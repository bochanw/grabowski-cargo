// ============================================================
// Serwerowy odpowiednik src/lib/pdf/extractPdfText.ts — wyciąga cały tekst PDF-a, żeby parsery
// znanych szablonów (supabase/functions/_shared/orderTemplates.ts) mogły zadziałać po stronie
// Edge Function, tak samo jak działają w przeglądarce przy ręcznym imporcie.
//
// Po co w ogóle, skoro jest Claude: znany szablon jest DARMOWY i deterministyczny, a Claude
// probabilistyczny i płatny. Wysyłanie do modelu dokumentu, który umiemy przeczytać regexem,
// byłoby cofnięciem się w dokładności, nie tylko wydatkiem.
//
// Różnice wobec wersji przeglądarkowej — obie wymuszone przez środowisko, nie kosmetyczne:
//  - build "legacy" i `useWorkerFetch: false`: w Edge Function nie ma Web Workera ani okna,
//  - `isEvalSupported: false`: pdf.js domyślnie kompiluje funkcje czcionek przez `eval`.
// SKLEJANIE STRON JEST TAKIE SAMO jak w przeglądarce (wszystkie strony w jeden ciąg, spacje
// znormalizowane) — regexy szablonów są dopasowane do TEGO tekstu i do niczego innego
// (patrz CLAUDE.md, pułapka z kotwicą `$` przy testowaniu na jednej stronie).
// ============================================================

import * as pdfjs from "npm:pdfjs-dist@4.7.76/legacy/build/pdf.mjs";

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    // Zawężenie przez `"str" in item` jak w wersji przeglądarkowej: getTextContent zwraca też
    // elementy TextMarkedContent (znaczniki struktury), które nie mają tekstu.
    pageTexts.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
  }
  return pageTexts.join(" ").replace(/\s+/g, " ").trim();
}
