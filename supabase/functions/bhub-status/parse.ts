// Odczyt danych kontenera z Baltic Hub.
//
// Kolumny i ich znaczenie są POTWIERDZONE na prawdziwym eksporcie z terminala (plik XLSX
// przysłany przez właściciela, 3 kontenery + 1 nieznany), a nie zgadnięte:
//
//   Unit Nbr        numer kontenera; "--Brak danych--" = terminal go nie zna
//   ISO Type        22G1 itd. → porównanie z "Wielkością" zlecenia
//   Line Operator   TRZYLITEROWY kod armatora (CMA, OOL, MSC) → porównanie z "Gestią"
//   Weight [KG]     waga brutto (sprawdzone: Cargo Weight + tara kontenera)
//   T-State         gdzie stoi kontener: "Yard" = plac, "Vessel" = statek
//   *Stops          stopki; PUSTE = brak blokad
//
// Reguła właściciela wprost: "Jeżeli *Stops jest puste, T-State Yard - dajemy ZP".
// Kod nie dopasowuje napisów do pięciu gotowych statusów, tylko składa je z tych dwóch kolumn
// (patrz deriveBhubStatus) — dzięki temu pozostałe kombinacje (statek, stopka) wychodzą same.
//
// ROZRÓŻNIENIE, które ma znaczenie: kolumna PUSTA to co innego niż kolumna, której NIE MA.
// Pusta "*Stops" znaczy "brak stopek". Brak kolumny znaczy "nie umiałem odczytać strony" i wtedy
// status musi zostać nieznany — inaczej nieudany odczyt pokazywałby dyspozytorowi spokojne ZP.

import { deriveBhubStatus, matchBhubStatus, type BhubStatus } from "./shared/status.ts";

export interface ParsedContainer {
  status: BhubStatus | null;
  /** Dosłownie to, co o stanie mówi terminal — pokazywane, gdy nie umiemy nadać kodu. */
  statusRaw: string | null;
  isoType: string | null;
  shippingLine: string | null;
  grossWeightKg: number | null;
  /** Komplet odczytanych pól. */
  details: Record<string, string>;
  /** Terminal odpowiedział, ale kontenera nie zna. */
  notFound: boolean;
  /**
   * Czy odpowiedź w ogóle udało się odczytać. `false` znaczy "nie wiem", a NIE "nic tam nie ma" —
   * i tylko przy `true` wolno nadpisać to, co już stoi przy zleceniu. Bez tego rozróżnienia
   * nieudany odczyt kasowałby poprzedni, dobry wynik (albo — jak się okazało na produkcji —
   * zostawiał na wierzchu śmieci z wcześniejszego przebiegu, których nie da się już wyczyścić).
   */
  recognised: boolean;
}

// Nazwy z eksportu Baltic Hub idą PIERWSZE, bo findByLabel próbuje najpierw trafienia dokładnego:
// "weightkg" łapie "Weight [KG]" i nie myli się z "Cargo Weight [KG]" ani "Commodity Weight [KG]".
// Dalsze warianty zostają na wypadek, gdyby strona (inaczej niż eksport) nazywała rubryki po polsku.
const LABELS = {
  container: ["unitnbr", "numer", "nrkontenera", "containerno", "container"],
  isoType: ["isotype", "typiso", "typkontenera", "containertype", "sizetype"],
  grossWeight: ["weightkg", "weight", "wagabrutto", "grossweight", "masabrutto", "vgm"],
  shippingLine: ["lineoperator", "armator", "operator", "shippingline", "carrier", "linia"],
  holds: ["stops", "stopki", "stopka", "blokady", "blokada", "holds", "hold"],
  location: ["tstate", "state", "lokalizacja", "polozenie", "location", "yard"],
  /** Osobna rubryka "status" bywa na stronie, w eksporcie jej nie ma — próbujemy jej najpierw. */
  status: ["statuskontenera", "containerstatus", "statuscontainer"],
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

export function stripTags(html: string): string {
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
 * Tabela KOLUMNOWA: wiersz nagłówków + wiersze danych (tak wygląda eksport terminala i tak
 * wyglądają wyniki dla wielu kontenerów naraz). Puste komórki ZOSTAJĄ w wyniku jako pusty tekst —
 * patrz komentarz na górze pliku: pusta "*Stops" to informacja, nie brak informacji.
 */
export function extractTableRows(html: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const table of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const trs = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
    if (trs.length < 2) continue;
    const cellsOf = (tr: string) =>
      [...tr.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) => stripTags(m[1]));
    const header = cellsOf(trs[0]);
    if (header.length < 2) continue;
    for (const tr of trs.slice(1)) {
      const cells = cellsOf(tr);
      if (cells.length === 0) continue;
      const row: Record<string, string> = {};
      header.forEach((name, i) => {
        if (name) row[name] = cells[i] ?? "";
      });
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Pary etykieta→wartość — układ "karty" (etykieta i wartość obok siebie), inny niż tabela
 * kolumnowa. Używane, gdy strona pokazuje jeden kontener zamiast listy.
 */
export function extractPairs(html: string): Record<string, string> {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const pairs: Record<string, string> = {};

  const add = (label: string, value: string) => {
    const key = stripTags(label);
    if (!key || key.length > 60) return;
    if (!(key in pairs)) pairs[key] = stripTags(value);
  };

  for (const dl of body.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    add(dl[1], dl[2]);
  }
  for (const line of stripTags(body).split(/(?=[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+\s*:)/)) {
    const match = line.match(/^([^:]{2,40}):\s*([^:]{1,80}?)\s*$/);
    if (match) add(match[1], match[2]);
  }
  return pairs;
}

/**
 * Wartość rubryki. `undefined` = TAKIEJ KOLUMNY NIE MA (nie umieliśmy odczytać),
 * pusty tekst = kolumna jest, ale pusta. To rozróżnienie decyduje o tym, czy wolno nadać status.
 */
export function pick(row: Record<string, string>, candidates: readonly string[]): string | undefined {
  const normalized = new Map(Object.entries(row).map(([k, v]) => [normalizeLabel(k), v]));
  for (const candidate of candidates) {
    const hit = normalized.get(candidate);
    if (hit !== undefined) return hit;
  }
  // Dopasowanie zapasowe tylko po POCZĄTKU nazwy ("Waga brutto [kg]" → "wagabrutto"), nigdy po
  // dowolnym fragmencie. Fragment byłby niebezpieczny właśnie przy wadze: "Cargo Weight [KG]"
  // zawiera "weightkg", więc przy braku kolumny "Weight [KG]" appka wzięłaby wagę TOWARU za wagę
  // brutto i zapisała ją przy zleceniu jako nadrzędną — cicho i bez śladu.
  for (const candidate of candidates) {
    for (const [key, value] of normalized) {
      if (key.startsWith(candidate)) return value;
    }
  }
  return undefined;
}

/** Liczba kilogramów z zapisu terminala: "8240", "8240.0", "23 976", "21126,5". */
export function parseWeight(raw: string | undefined): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d.,]/g, "").replace(/\s/g, "");
  if (!digits) return null;
  // Separator tysięcy odpada tylko wtedy, gdy po nim stoją dokładnie trzy cyfry.
  const normalized = digits.replace(/[.,](?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Kod ISO 6346 (22G1, 45G1, 22U1, 22UT).
 *
 * Wzorzec jest WĄSKI, bo szeroki narobił szkody: pierwsza wersja `[2-4L9][0-9A-Z][A-Z][0-9A-Z]`
 * łapała zwykłe angielskie słowa ze strony — do bazy trafiły "LINK" i "LEFT" jako typ kontenera.
 * Teraz każdy znak musi być z zestawu dopuszczalnego w tej pozycji normy:
 *   1. długość  — TYLKO 2 (20 stóp), 4 (40) i L (45). Kody 1/3/9/M/N/P (10, 30, 48, 49, 53
 *      stóp) są w obrocie morskim martwe, a wpuszczone tu kosztowały: przy "M" słowo "MENU"
 *      przechodziło jako poprawny kod kontenera.
 *   2. wysokość (cyfry oraz C-F dla kontenerów o zmiennej wysokości)
 *   3. rodzina  (G general, U open top, R chłodnia, T cysterna, P platforma …)
 * "LINK" odpada na drugim znaku, "LEFT" na trzecim.
 */
const ISO_CODE = /^[24L][0-9CDEF][ABGHKNPRSTUV][0-9A-Z]$/;

export function parseIsoCode(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) return null;
  if (ISO_CODE.test(value)) return value;
  const match = value.match(/\b([24L][0-9CDEF][ABGHKNPRSTUV][0-9A-Z])\b/);
  return match ? match[1] : null;
}

const NOT_FOUND = /brak danych|brak wynik|nie znaleziono|not found|no results/i;

/**
 * Jeden wiersz danych terminala → to, co appka zapisuje przy zleceniu. Wspólne dla KAŻDEGO źródła
 * (tabela na stronie, eksport, w przyszłości API) — różni się tylko to, jak powstaje `row`.
 */
export function interpretRow(row: Record<string, string>): Omit<ParsedContainer, "details"> {
  const containerCell = pick(row, LABELS.container) ?? "";
  if (NOT_FOUND.test(containerCell) || Object.values(row).every((v) => !v.trim())) {
    return { status: null, statusRaw: null, isoType: null, shippingLine: null, grossWeightKg: null, notFound: true, recognised: true };
  }

  const location = pick(row, LABELS.location);
  const holds = pick(row, LABELS.holds);
  const statusCell = pick(row, LABELS.status);

  // Kolejność: gotowy status z osobnej rubryki, potem złożenie z miejsca i stopek.
  let status = matchBhubStatus(statusCell);
  if (!status && location !== undefined && holds !== undefined) {
    const place = location.toLowerCase();
    const onVessel = /statk|statek|vessel|burt|ship/.test(place)
      ? true
      : /yard|plac|sklad|skład|terminal|ground/.test(place)
        ? false
        : null;
    const holdsText = holds.trim().toLowerCase();
    status = deriveBhubStatus({
      onVessel,
      operationalHold: /operacyj|operational/.test(holdsText),
      // Reguła właściciela: puste "*Stops" = brak blokad.
      held: holdsText !== "" && !/brak|none|no holds/.test(holdsText),
    });
  }

  const statusRaw = [statusCell, location, holds].filter((v) => v && v.trim()).join(" / ") || null;

  return {
    status,
    statusRaw,
    isoType: parseIsoCode(pick(row, LABELS.isoType)),
    shippingLine: (pick(row, LABELS.shippingLine) ?? "").trim() || null,
    grossWeightKg: parseWeight(pick(row, LABELS.grossWeight)),
    notFound: false,
    recognised: true,
  };
}

/**
 * Migawka diagnostyczna nierozpoznanej strony — wszystko, czego trzeba, żeby ustalić, jak ta strona
 * przyjmuje numer kontenera i gdzie oddaje wynik. Świadomie NIE jest to całe źródło strony:
 * interesuje nas formularz, jego pola, skrypty i widoczny tekst, a nie kilkaset kilobajtów CSS-a.
 */
function describePage(html: string, text: string): Record<string, string> {
  const forms = [...html.matchAll(/<form[^>]*>/gi)].map((m) => m[0]);
  const fields = [...html.matchAll(/<(input|select|textarea|button)\b[^>]*>/gi)]
    .map((m) => (m[0].length > 300 ? `${m[0].slice(0, 300)}…` : m[0]));
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

/** Numer kontenera do porównań: same znaki alfanumeryczne, wielkimi literami. */
function key(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Odczyt odpowiedzi terminala dla JEDNEGO kontenera. Odpowiedź może zawierać wiele kontenerów
 * (formularz przyjmuje do dziesięciu po przecinku), więc najpierw szukamy wiersza z naszym numerem.
 */
export function parseContainerPage(html: string, containerNumber: string): ParsedContainer {
  const wanted = key(containerNumber);
  const rows = extractTableRows(html);
  const row =
    rows.find((r) => Object.values(r).some((v) => key(v) === wanted)) ??
    (rows.length === 1 ? rows[0] : undefined);

  const text = stripTags(html);
  if (row) {
    return { ...interpretRow(row), details: { ...row, _container: containerNumber } };
  }

  // Brak tabeli — próbujemy układu "karty" (etykieta → wartość).
  const pairs = extractPairs(html);
  if (Object.keys(pairs).length >= 3) {
    return { ...interpretRow(pairs), details: { ...pairs, _container: containerNumber } };
  }

  // Nic nie rozpoznaliśmy. Jeśli strona wprost mówi, że nie zna kontenera — to nie jest błąd.
  const notFound = NOT_FOUND.test(text);
  return {
    status: null,
    statusRaw: null,
    isoType: null,
    shippingLine: null,
    grossWeightKg: null,
    notFound,
    // Strona, której nie umieliśmy odczytać, NIE jest odpowiedzią "nic nie znaleziono" — chyba że
    // sama tak mówi. Inaczej byłoby to milczące skasowanie poprzedniego, dobrego wyniku.
    recognised: notFound,
    details: { ...describePage(html, text), _container: containerNumber },
  };
}
