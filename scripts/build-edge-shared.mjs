// ============================================================
// Generuje supabase/functions/mail-poll/shared/ z modułów aplikacji (src/).
//
// Po co: parsery znanych szablonów (src/lib/orderTemplates/) muszą działać w DWÓCH miejscach —
// w przeglądarce przy ręcznym imporcie i w Edge Function `mail-poll` przy odczycie ze skrzynki.
// Dwie ręcznie utrzymywane kopie tych samych regexów rozjechałyby się przy pierwszej poprawce
// (a regexy tego parsera już raz były źródłem cichego błędu — patrz CLAUDE.md, pułapka z kotwicą
// `$`). Źródłem prawdy zostaje `src/`; ten skrypt robi z niego kopię dla Deno.
//
// Jedyna różnica kopii: Deno wymaga rozszerzeń w importach relatywnych i nie zna aliasu `@/`,
// więc specyfikatory są przepisywane. Nic poza importami nie jest ruszane.
//
// Uruchomienie: node scripts/build-edge-shared.mjs
// Odpalać po KAŻDEJ zmianie w plikach z listy MODULES, przed wdrożeniem `mail-poll`.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Funkcja brzegowa → (ścieżka w src → nazwa pliku w jej katalogu shared/). Płaska struktura:
// w bundlu nie ma sensu odtwarzać drzewa aplikacji, a płasko łatwiej przepisać importy.
const TARGETS = {
  "mail-poll": {
    "src/types/parsedOrder.ts": "parsedOrder.ts",
    // Kolejne miejsca załadunku/rozładunku — kształt listy i jej normalizacja (ParsedOrder ją
    // importuje, więc bez tego pliku bundle się nie zbuduje).
    "src/types/loadStop.ts": "loadStop.ts",
    "src/lib/containers/tare.ts": "tare.ts",
    "src/lib/orderTemplates/pickupLocations.ts": "pickupLocations.ts",
    "src/lib/orderTemplates/q4road.ts": "q4road.ts",
    "src/lib/orderTemplates/index.ts": "orderTemplates.ts",
    // Nauczone szablony (auto-nauka): do Deno jedzie TYLKO połowa CZYTAJĄCA (readTemplate.ts).
    // Uczy się wyłącznie przeglądarka — serwer ma stosować gotowe reguły, nie wyprowadzać nowych.
    "src/lib/orderTemplates/readTemplate.ts": "readTemplate.ts",
    "src/lib/dates/workingDays.ts": "workingDays.ts",
    "src/lib/loads/orderNumber.ts": "orderNumber.ts",
  },
  // Odpytywanie Baltic Hub: okno godzinowe (dni robocze 6-18) i model pięciu statusów muszą
  // znaczyć DOKŁADNIE to samo w przeglądarce i w cronie — stąd kopia, a nie druga implementacja.
  "bhub-status": {
    "src/lib/dates/workingDays.ts": "workingDays.ts",
    "src/lib/bhub/status.ts": "status.ts",
    "src/lib/bhub/schedule.ts": "schedule.ts",
    // Kod ISO terminala → zapis "Wielkości" ze zleceń ("22G1" → "20 DV"). Ta sama tabela służy
    // w przeglądarce do alarmu przy niezgodności, a w funkcji do uzupełnienia pustego pola —
    // dwie kopie rozjechałyby się przy pierwszej poprawce.
    "src/lib/bhub/isoType.ts": "isoType.ts",
  },
};

// Specyfikator w src → specyfikator w bundlu.
const REWRITES = [
  [/from "@\/types\/parsedOrder"/g, 'from "./parsedOrder.ts"'],
  [/from "\.\.\/\.\.\/types\/parsedOrder"/g, 'from "./parsedOrder.ts"'],
  [/from "\.\.\/containers\/tare"/g, 'from "./tare.ts"'],
  [/from "\.\.\/lib\/orderTemplates\/pickupLocations"/g, 'from "./pickupLocations.ts"'],
  [/from "\.\/pickupLocations"/g, 'from "./pickupLocations.ts"'],
  [/from "\.\/loadStop"/g, 'from "./loadStop.ts"'],
  [/from "\.\/q4road"/g, 'from "./q4road.ts"'],
  [/from "\.\.\/dates\/workingDays"/g, 'from "./workingDays.ts"'],
  [/from "\.\/status"/g, 'from "./status.ts"'],
];

const BANNER = (source) =>
  `// PLIK GENEROWANY — nie edytuj tutaj. Źródło: ${source}\n` +
  `// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).\n\n`;

let unresolved = [];
let count = 0;
for (const [fn, modules] of Object.entries(TARGETS)) {
  const outDir = join(root, "supabase", "functions", fn, "shared");
  mkdirSync(outDir, { recursive: true });

  for (const [src, out] of Object.entries(modules)) {
    let code = readFileSync(join(root, src), "utf8");
    // "use client" nie znaczy nic w Deno, ale zostawiony wygląda na pomyłkę — usuwamy.
    code = code.replace(/^["']use client["'];?\s*\n/m, "");
    for (const [pattern, replacement] of REWRITES) code = code.replace(pattern, replacement);

    // Kontrola: po przepisaniu NIE MOŻE zostać żaden import bez rozszerzenia albo z aliasem —
    // taki bundle wdrożyłby się i wywalił dopiero przy pierwszym mailu.
    for (const match of code.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = match[1];
      const bare = !spec.startsWith(".") && !spec.startsWith("npm:") && !spec.startsWith("jsr:") && !spec.startsWith("http");
      if (bare || (spec.startsWith(".") && !spec.endsWith(".ts"))) {
        unresolved.push(`${src} → ${spec} (${fn})`);
      }
    }

    writeFileSync(join(outDir, out), BANNER(src) + code);
    console.log(`  ${src} → supabase/functions/${fn}/shared/${out}`);
    count += 1;
  }
}

if (unresolved.length > 0) {
  console.error("\nBŁĄD: importy nie do rozwiązania w Deno (dopisz regułę do REWRITES):");
  for (const u of unresolved) console.error(`  ${u}`);
  process.exit(1);
}
console.log(`\nGotowe — ${count} plików.`);
