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
const outDir = join(root, "supabase", "functions", "mail-poll", "shared");

// Ścieżka w src → ścieżka w _shared. Płaska struktura: w bundlu nie ma sensu odtwarzać drzewa
// aplikacji, a płasko łatwiej przepisać importy.
const MODULES = {
  "src/types/parsedOrder.ts": "parsedOrder.ts",
  "src/lib/containers/tare.ts": "tare.ts",
  "src/lib/orderTemplates/pickupLocations.ts": "pickupLocations.ts",
  "src/lib/orderTemplates/q4road.ts": "q4road.ts",
  "src/lib/orderTemplates/index.ts": "orderTemplates.ts",
  "src/lib/dates/workingDays.ts": "workingDays.ts",
  "src/lib/loads/orderNumber.ts": "orderNumber.ts",
};

// Specyfikator w src → specyfikator w bundlu.
const REWRITES = [
  [/from "@\/types\/parsedOrder"/g, 'from "./parsedOrder.ts"'],
  [/from "\.\.\/\.\.\/types\/parsedOrder"/g, 'from "./parsedOrder.ts"'],
  [/from "\.\.\/containers\/tare"/g, 'from "./tare.ts"'],
  [/from "\.\.\/lib\/orderTemplates\/pickupLocations"/g, 'from "./pickupLocations.ts"'],
  [/from "\.\/pickupLocations"/g, 'from "./pickupLocations.ts"'],
  [/from "\.\/q4road"/g, 'from "./q4road.ts"'],
];

const BANNER = (source) =>
  `// PLIK GENEROWANY — nie edytuj tutaj. Źródło: ${source}\n` +
  `// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).\n\n`;

mkdirSync(outDir, { recursive: true });

let unresolved = [];
for (const [src, out] of Object.entries(MODULES)) {
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
      unresolved.push(`${src} → ${spec}`);
    }
  }

  writeFileSync(join(outDir, out), BANNER(src) + code);
  console.log(`  ${src} → supabase/functions/mail-poll/shared/${out}`);
}

if (unresolved.length > 0) {
  console.error("\nBŁĄD: importy nie do rozwiązania w Deno (dopisz regułę do REWRITES):");
  for (const u of unresolved) console.error(`  ${u}`);
  process.exit(1);
}
console.log(`\nGotowe — ${Object.keys(MODULES).length} modułów.`);
