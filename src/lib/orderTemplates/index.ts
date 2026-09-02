import type { ParsedOrder } from "@/types/parsedOrder";
import { detectQ4Road, parseQ4Road } from "./q4road";

// Rejestr znanych szablonów zleceń — właściciel wprost poprosił o rozpoznawanie po spedytorze
// zamiast od razu wysyłać każdy PDF do modelu: "z czasem będziemy rozbudowywać go o kolejnych
// klientów, żebym ręcznie nie dodawał". Deterministyczny parser (regex na tekście z pdf.js) nie
// wymaga żadnego wdrożenia ani klucza API — działa od razu, w przeglądarce. Odczyt przez Claude
// (supabase/functions/parse-order-pdf) zostaje jako DOCELOWY fallback dla nieznanych szablonów —
// świadomie jeszcze niepodłączony pod ten rejestr, patrz CLAUDE.md.
interface OrderTemplate {
  name: string;
  detect: (text: string) => boolean;
  parse: (text: string) => ParsedOrder;
}

const KNOWN_TEMPLATES: OrderTemplate[] = [
  { name: "Q4Road", detect: detectQ4Road, parse: parseQ4Road },
];

export function matchKnownTemplate(text: string): { name: string; parsed: ParsedOrder } | null {
  for (const template of KNOWN_TEMPLATES) {
    if (template.detect(text)) {
      return { name: template.name, parsed: template.parse(text) };
    }
  }
  return null;
}
