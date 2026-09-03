// Odczyt strony Baltic Hub z wynikiem dla kontenera.
//
// ============== UWAGA — TO JEDYNY KAWAŁEK NIEZWERYFIKOWANY ==============
// Strony nie dało się otworzyć z tego środowiska (Cloudflare — patrz komentarz w source.ts), więc
// NIE ZNAM jej układu ani nazw rubryk. Zgadywanie regexów pod niewidzianą stronę już raz kosztowało
// tę appkę cichy błąd (CLAUDE.md, pułapka z kotwicą `$`), więc parser jest napisany tak, żeby
// pierwsze prawdziwe uruchomienie SAMO powiedziało, jak stronę czytać:
//
//   1. `extractPairs` wyciąga WSZYSTKIE pary etykieta→wartość z tabel i list definicyjnych, nie
//      znając z góry ani jednej nazwy rubryki.
//   2. Komplet par leci do `loads.bhub_details` przy każdym sprawdzeniu.
//   3. Nazwy rubryk, które nas interesują, siedzą niżej w jednym słowniku LABELS — po pierwszym
//      przebiegu wystarczy zajrzeć w `bhub_details` i dopisać faktyczne nazwy.
//
// Dzięki temu nierozpoznana strona nie kończy się pustym polem bez śladu: dane surowe są zapisane,
// a status bez przypisanego kodu appka pokazuje dosłownie (bez koloru), zamiast zgadywać.
// =======================================================================

import { deriveBhubStatus, matchBhubStatus, type BhubStatus } from "./shared/status.ts";

export interface ParsedContainer {
  status: BhubStatus | null;
  /** Dosłownie to, co o statusie mówi strona — pokazywane, gdy nie umiemy nadać kodu. */
  statusRaw: string | null;
  isoType: string | null;
  shippingLine: string | null;
  grossWeightKg: number | null;
  /** Komplet odczytanych par etykieta→wartość. */
  details: Record<string, string>;
  /** Strona odpowiedziała, ale kontenera nie zna. */
  notFound: boolean;
}

// Kandydaci na nazwy rubryk — porównanie po formie znormalizowanej (bez wielkości liter, spacji
// i znaków). Lista jest CELOWO szeroka (polski i angielski, warianty), bo tańsze jest dopisanie
// nazwy, której strona nie używa, niż przeoczenie tej, której używa.
const LABELS = {
  isoType: ["isotype", "iso", "typiso", "typkontenera", "containertype", "sizetype", "typ"],
  grossWeight: ["wagabrutto", "brutto", "grossweight", "vgm", "waga", "weight", "masabrutto"],
  shippingLine: ["armator", "linia", "gestia", "shippingline", "carrier", "line", "operator"],
  status: ["status", "statuskontenera", "containerstatus", "stan"],
  holds: ["stopki", "stopka", "blokady", "blokada", "holds", "hold"],
  location: ["lokalizacja", "miejsce", "polozenie", "położenie", "location", "position", "yard"],
} as const;

function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[ąàáâä]/g, "a")
    .replace(/[ćč]/g, "c")
    .replace(/[ęèéêë]/g, "e")
    .replace(/ł/g, "l")
    .replace(/ń/g, "n")
    .replace(/[óòôö]/g, "o")
    .replace(/[śš]/g, "s")
    .replace(/[żźž]/g, "z")
    .replace(/[^a-z0-9]/g, "");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pary etykieta→wartość z układów, w których wyniki takich formularzy praktycznie zawsze stoją:
 * wiersz tabeli (nagłówek + komórka), dwie komórki obok siebie, lista definicyjna, oraz
 * "Etykieta: wartość" w zwykłym tekście.
 */
export function extractPairs(html: string): Record<string, string> {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const pairs: Record<string, string> = {};

  const add = (label: string, value: string) => {
    const key = stripTags(label);
    const val = stripTags(value);
    // Pusta wartość albo etykieta dłuższa niż etykieta bywa (to już zdanie) — pomijamy.
    if (!key || !val || key.length > 60) return;
    if (!(key in pairs)) pairs[key] = val;
  };

  // <tr><th|td>etykieta</th|td><td>wartość</td></tr>
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) => m[1]);
    if (cells.length === 2) add(cells[0], cells[1]);
  }
  // <dt>etykieta</dt><dd>wartość</dd>
  for (const dl of body.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    add(dl[1], dl[2]);
  }
  // "Etykieta: wartość" w zwykłym tekście (ostatnia deska ratunku, gdy wynik nie jest tabelą).
  for (const line of stripTags(body).split(/(?=[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+\s*:)/)) {
    const match = line.match(/^([^:]{2,40}):\s*([^:]{1,80}?)\s*$/);
    if (match) add(match[1], match[2]);
  }
  return pairs;
}

function findByLabel(pairs: Record<string, string>, candidates: readonly string[]): string | null {
  const normalized = new Map(Object.entries(pairs).map(([k, v]) => [normalizeLabel(k), v]));
  for (const candidate of candidates) {
    const hit = normalized.get(candidate);
    if (hit) return hit;
  }
  // Dopasowanie po fragmencie ("Waga brutto [kg]" zawiera "wagabrutto").
  for (const candidate of candidates) {
    for (const [key, value] of normalized) {
      if (key.includes(candidate)) return value;
    }
  }
  return null;
}

/** Liczba kilogramów z zapisu strony: "32 500", "32500 kg", "32.5 t", "24 000,50". */
export function parseWeight(raw: string | null): number | null {
  if (!raw) return null;
  const isTons = /\bt(ony|on|\b)/i.test(raw) && !/\bkg\b/i.test(raw);
  const digits = raw.replace(/[^\d.,]/g, "").replace(/\s/g, "");
  if (!digits) return null;
  // Separator dziesiętny to ostatni przecinek/kropka, o ile po nim są 1-2 cyfry; reszta to tysiące.
  const normalized = digits.replace(/[.,](?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return isTons ? value * 1000 : value;
}

/** Kod ISO 6346 (np. 22G1, 45G1, 22U1) wyłuskany z wartości rubryki. */
export function parseIsoCode(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.toUpperCase().match(/\b([2-4L9][0-9A-Z][A-Z][0-9A-Z])\b/);
  return match ? match[1] : null;
}

/**
 * Migawka diagnostyczna nierozpoznanej strony — wszystko, czego trzeba, żeby ustalić, jak ta strona
 * przyjmuje numer kontenera i gdzie oddaje wynik. Świadomie NIE jest to całe źródło strony:
 * interesuje nas formularz, jego pola, skrypty i widoczny tekst, a nie kilkaset kilobajtów CSS-a.
 */
function describePage(html: string, text: string): Record<string, string> {
  const forms = [...html.matchAll(/<form[^>]*>/gi)].map((m) => m[0]);
  const fields = [...html.matchAll(/<(input|select|textarea|button)\b[^>]*>/gi)]
    .map((m) => m[0])
    // Ukryte pola tokenów ASP.NET potrafią mieć ogromne wartości — obcinamy, nazwa wystarczy.
    .map((tag) => (tag.length > 300 ? `${tag.slice(0, 300)}…` : tag));
  const scripts = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]);
  const bodyStart = html.search(/<body\b/i);

  return {
    _tekst_strony: text.slice(0, 2000),
    _formularze: forms.join("\n") || "(brak znacznika <form>)",
    _pola: fields.join("\n").slice(0, 4000) || "(brak pól)",
    _skrypty: scripts.join("\n").slice(0, 2000),
    _html_body: (bodyStart >= 0 ? html.slice(bodyStart) : html).slice(0, 30000),
  };
}

export function parseContainerPage(html: string, containerNumber: string): ParsedContainer {
  const details = extractPairs(html);
  const text = stripTags(html);

  // Kontener nieznany terminalowi — komunikat, nie błąd transportu.
  const notFound =
    Object.keys(details).length === 0 &&
    /nie znaleziono|brak wynik|not found|no results|nie ma takiego/i.test(text);

  const statusRaw = findByLabel(details, LABELS.status);
  const holdsRaw = findByLabel(details, LABELS.holds);
  const locationRaw = findByLabel(details, LABELS.location);

  // Najpierw próba wprost z rubryki "status", potem złożenie z dwóch faktów (gdzie stoi + czy jest
  // stopka) — patrz deriveBhubStatus w shared/status.ts.
  let status = matchBhubStatus(statusRaw);
  if (!status) {
    const haystack = `${locationRaw ?? ""} ${statusRaw ?? ""} ${holdsRaw ?? ""}`.toLowerCase();
    const onVessel = /statk|statek|vessel|burt/.test(haystack)
      ? true
      : /plac|yard|skład|sklad|terminal/.test(haystack)
        ? false
        : null;
    const heldText = `${statusRaw ?? ""} ${holdsRaw ?? ""}`.toLowerCase();
    const noHolds = /brak|none|bez stopek|nie ma/.test(heldText) || (holdsRaw ?? "") === "";
    status = deriveBhubStatus({
      onVessel,
      operationalHold: /operacyjn|operational/.test(heldText),
      held: !noHolds,
    });
  }

  // Samodiagnoza: jeśli ze strony nie dało się wyciągnąć praktycznie nic, dokładamy do migawki to,
  // co pozwala ustalić DLACZEGO. Pierwszy przebieg pokazał, że sam adres z numerem w parametrze
  // zwraca pusty formularz — więc diagnoza musi obejmować sam formularz (jak wysyła dane) i listę
  // skryptów (gdzie szukać wywołania AJAX), a nie tylko sekcję <head>, która nic nie mówiła.
  // Gdy etykiety zaczną się rozpoznawać, cały ten dopisek znika sam.
  const diagnostics = Object.keys(details).length < 3 ? describePage(html, text) : {};

  return {
    status,
    statusRaw: statusRaw ?? holdsRaw ?? null,
    isoType: parseIsoCode(findByLabel(details, LABELS.isoType)) ?? parseIsoCode(text),
    shippingLine: findByLabel(details, LABELS.shippingLine),
    grossWeightKg: parseWeight(findByLabel(details, LABELS.grossWeight)),
    details: { ...details, ...diagnostics, _container: containerNumber },
    notFound,
  };
}
