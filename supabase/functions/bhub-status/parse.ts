// Odczyt danych kontenera z Baltic Hub.
//
// Kolumny i ich znaczenie są POTWIERDZONE na prawdziwym eksporcie z terminala (plik XLSX
// przysłany przez właściciela, 3 kontenery + 1 nieznany), a nie zgadnięte:
//
//   Unit Nbr        numer kontenera; "--Brak danych--" = terminal go nie zna
//   ISO Type        22G1 itd. → porównanie z "Wielkością" zlecenia
//   Line Operator   TRZYLITEROWY kod armatora (CMA, OOL, MSC) → porównanie z "Gestią"
//   Weight [KG]     waga brutto (sprawdzone: Cargo Weight + tara kontenera)
//   T-State         gdzie stoi kontener — OSIEM wartości opisanych przez terminal (Inbound, Yard,
//                   EC/In, EC/Out, Departed, Loaded, Advised, Retired); patrz słownik T_STATE
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
  /** `Weight [KG]` — waga VGM, czyli brutto. */
  grossWeightKg: number | null;
  /** `Cargo Weight [KG]` — VGM minus tara, czyli waga samego towaru (u nas „Waga netto"). */
  netWeightKg: number | null;
  /** `Commodity Weight [KG]` — waga zgłoszona do Urzędu Celnego; powinna równać się `Cargo Weight`. */
  commodityWeightKg: number | null;
  /**
   * `Time Out` — kiedy kontener opuścił terminal. PUSTY TEKST znaczy „rubryka jest i jest pusta"
   * (czyli kontener stoi), `null` — „nie odczytałem". To rozróżnienie decyduje o ostrzeżeniu,
   * więc nie wolno go zgubić: brak odczytu nie może wyglądać jak spokojne „pusto".
   */
  timeOut: string | null;
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
  /** Nazwany powód, gdy odpowiedzi nie da się odczytać (np. wygasły token sesji). */
  reason?: string;
}

// Nazwy z eksportu Baltic Hub idą PIERWSZE, bo findByLabel próbuje najpierw trafienia dokładnego:
// "weightkg" łapie "Weight [KG]" i nie myli się z "Cargo Weight [KG]" ani "Commodity Weight [KG]".
// Dalsze warianty zostają na wypadek, gdyby strona (inaczej niż eksport) nazywała rubryki po polsku.
const LABELS = {
  container: ["unitnbr", "numer", "nrkontenera", "containerno", "container"],
  // „rozmiariso" i „dataczaspodjecia" to kolumny GCT (po polsku) — patrz fixtures/gct-*.txt.
  isoType: ["isotype", "typiso", "typkontenera", "containertype", "sizetype", "rozmiariso"],
  grossWeight: ["weightkg", "weight", "wagabrutto", "grossweight", "masabrutto", "vgm"],
  // KOLEJNOŚĆ I DOKŁADNOŚĆ MA ZNACZENIE: „Cargo Weight [KG]" zawiera w sobie „Weight [KG]", więc
  // przy niedokładnym dopasowaniu waga towaru zostałaby wzięta za brutto (patrz komentarz w `pick`).
  cargoWeight: ["cargoweightkg", "cargoweight", "waganetto", "wagatowaru"],
  commodityWeight: ["commodityweightkg", "commodityweight", "wagacelna"],
  // GCT nie ma „Time Out", tylko „Data/Czas podjęcia" — ta sama informacja: kiedy kontener
  // opuścił terminal. Pusta = wciąż stoi.
  timeOut: ["timeout", "dataczaspodjecia", "czaswyjazdu", "datawyjazdu"],
  shippingLine: ["lineoperator", "armator", "operator", "shippingline", "carrier", "linia"],
  holds: ["stops", "stopki", "stopka", "blokady", "blokada", "holds", "hold"],
  location: ["tstate", "state", "lokalizacja", "polozenie", "location", "yard"],
  /** Osobna rubryka "status" bywa na stronie, w eksporcie jej nie ma — próbujemy jej najpierw. */
  // „status" (samo) jest OSTATNIE: dopasowanie dokładne wygrywa nad zapasowym po początku nazwy,
  // więc kolumna GCT „Status" trafia tutaj, a sąsiednia „Status celny" się pod nią nie podszyje.
  status: ["statuskontenera", "containerstatus", "statuscontainer", "status"],
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
/**
 * Zapis „nic tu nie ma" bywa różny: Baltic Hub zostawia pustkę, BCT wpisuje „--", GCT twardą
 * spację. Dla nas wszystkie znaczą to samo — inaczej „--" w rubryce „Stops" zostałoby wzięte za
 * BLOKADĘ na kontenerze, a to jest różnica między „można zabierać" a „nie wolno".
 */
export function pusteJakoPuste(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.replace(/\u00A0/g, " ").trim();
  return /^(-{1,3}|\u2013|\u2014|n\/?a|brak)$/i.test(v) ? "" : v;
}

export function pick(row: Record<string, string>, candidates: readonly string[]): string | undefined {
  const normalized = new Map(Object.entries(row).map(([k, v]) => [normalizeLabel(k), v]));
  for (const candidate of candidates) {
    const hit = normalized.get(candidate);
    if (hit !== undefined) return pusteJakoPuste(hit);
  }
  // Dopasowanie zapasowe tylko po POCZĄTKU nazwy ("Waga brutto [kg]" → "wagabrutto"), nigdy po
  // dowolnym fragmencie. Fragment byłby niebezpieczny właśnie przy wadze: "Cargo Weight [KG]"
  // zawiera "weightkg", więc przy braku kolumny "Weight [KG]" appka wzięłaby wagę TOWARU za wagę
  // brutto i zapisała ją przy zleceniu jako nadrzędną — cicho i bez śladu.
  for (const candidate of candidates) {
    for (const [key, value] of normalized) {
      if (key.startsWith(candidate)) return pusteJakoPuste(value);
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
//
// DWA ZAPISY, oba spotkane na produkcji: literowy („22G1" — Baltic Hub, GCT) i STARY LICZBOWY
// („2210" — tak podaje BCT). W obu długość niesie pierwszy znak, a różni je trzeci: litera rodziny
// albo dwie cyfry grupy typu. Wariant liczbowy jest bezpieczny dla tej samej pułapki co literowy —
// angielskie słowo nie ma cyfr na dwóch ostatnich pozycjach.
const ISO_CODE = /^[24L][0-9CDEF](?:[ABGHKNPRSTUV][0-9A-Z]|[0-9]{2})$/;

export function parseIsoCode(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) return null;
  if (ISO_CODE.test(value)) return value;
  const match = value.match(/\b([24L][0-9CDEF](?:[ABGHKNPRSTUV][0-9A-Z]|[0-9]{2}))\b/);
  return match ? match[1] : null;
}

const NOT_FOUND = /brak danych|brak wynik|nie znaleziono|not found|no results/i;

/**
 * Laravel odrzuca POST bez ważnego tokenu sesji stroną "Page Expired" (HTTP 419). Nazywamy to po
 * imieniu, bo inaczej wygląda to jak "nie rozumiem odpowiedzi", a to zupełnie inny problem:
 * zapytanie doszło pod właściwy adres i we właściwej formie, tylko bez tokenu.
 */
export const PAGE_EXPIRED = /page expired|419|token.*wygas|sesja wygas/i;

/**
 * Słownik wartości `T-State` przepisany WPROST z opisu Baltic Hub ("Opis elementów karty
 * kontenera" na stronie sprawdzania kontenera) — nie z domysłu:
 *
 *   Inbound   kontener w drodze na terminal      (dla importu morskiego: jeszcze na statku)
 *   Yard      kontener na terminalu
 *   EC/In     dostarczony, ale nie na wyznaczonej pozycji na placu  → wciąż na terminalu
 *   EC/Out    przewoźnik przyjechał po kontener
 *   Departed  kontener opuścił terminal
 *   Loaded    załadowany na kolejny środek transportu
 *   Advised   niepełna awizacja
 *   Retired   status po rozformowaniu
 *
 * WAŻNE: nie ma wartości "Vessel" — pierwsza wersja kodu jej szukała i przez to kontener w drodze
 * nie dostawał żadnego statusu.
 *
 * Pięć kodów właściciela (SS/ZS/SO/SP/ZP) opisuje wyłącznie oś "statek ↔ plac", więc stany
 * oznaczające "kontenera już tu nie ma" (Departed/Loaded/Retired/EC/Out) i "Advised" celowo NIE
 * dostają kodu: wracają jako surowy tekst bez koloru, do wyjaśnienia z właścicielem.
 */
const T_STATE: Record<string, "plac" | "statek" | "poza"> = {
  inbound: "statek",
  yard: "plac",
  ecin: "plac",
  ecout: "poza",
  departed: "poza",
  loaded: "poza",
  retired: "poza",
  advised: "poza",
};

/** Gdzie stoi kontener wg `T-State`: true = na statku, false = na placu, null = nie wiemy. */
export function locationFromTState(raw: string): boolean | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  const known = T_STATE[key];
  if (known === "plac") return false;
  if (known === "statek") return true;
  if (known === "poza") return null;
  // Zapis spoza słownika — próbujemy jeszcze po słowach, ale nic nie zgadujemy na siłę.
  if (/statk|statek|vessel|burt|ship/.test(raw.toLowerCase())) return true;
  if (/plac|sklad|skład|terminal|ground/.test(raw.toLowerCase())) return false;
  return null;
}

/**
 * Jeden wiersz danych terminala → to, co appka zapisuje przy zleceniu. Wspólne dla KAŻDEGO źródła
 * (tabela na stronie, eksport, w przyszłości API) — różni się tylko to, jak powstaje `row`.
 */
export function interpretRow(row: Record<string, string>): Omit<ParsedContainer, "details"> {
  const containerCell = pick(row, LABELS.container) ?? "";
  if (NOT_FOUND.test(containerCell) || Object.values(row).every((v) => !v.trim())) {
    return { ...PUSTE, notFound: true, recognised: true };
  }

  const location = pick(row, LABELS.location);
  const holds = pick(row, LABELS.holds);
  const statusCell = pick(row, LABELS.status);

  // Kolejność: gotowy status z osobnej rubryki, potem złożenie z miejsca i stopek.
  let status = matchBhubStatus(statusCell);
  if (!status && location !== undefined && holds !== undefined) {
    const onVessel = locationFromTState(location);
    const holdsText = holds.trim().toLowerCase();
    status = deriveBhubStatus({
      onVessel,
      operationalHold: /operacyj|operational/.test(holdsText),
      // Reguła właściciela: puste "*Stops" = brak blokad.
      held: holdsText !== "" && !/brak|none|no holds/.test(holdsText),
    });
  }

  const statusRaw = [statusCell, location, holds].filter((v) => v && v.trim()).join(" / ") || null;
  const timeOut = pick(row, LABELS.timeOut);

  return {
    status,
    statusRaw,
    isoType: parseIsoCode(pick(row, LABELS.isoType)),
    shippingLine: (pick(row, LABELS.shippingLine) ?? "").trim() || null,
    grossWeightKg: parseWeight(pick(row, LABELS.grossWeight)),
    netWeightKg: parseWeight(pick(row, LABELS.cargoWeight)),
    commodityWeightKg: parseWeight(pick(row, LABELS.commodityWeight)),
    // `undefined` (rubryki nie ma) → null „nie wiem"; pusty tekst zostaje pustym tekstem.
    timeOut: timeOut === undefined ? null : timeOut.trim(),
    notFound: false,
    recognised: true,
  };
}

/**
 * „Nic nie odczytano" — wspólna podstawa dla odpowiedzi bez danych. Osobna stała, bo tych miejsc
 * są cztery: dopisanie pola i przeoczenie jednego z nich to cichy `undefined` w zapisie do bazy.
 */
const PUSTE: Omit<ParsedContainer, "details" | "notFound" | "recognised"> = {
  status: null,
  statusRaw: null,
  isoType: null,
  shippingLine: null,
  grossWeightKg: null,
  netWeightKg: null,
  commodityWeightKg: null,
  timeOut: null,
};

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
 * Etykiety KARTY KONTENERA — przepisane z PRAWDZIWEJ odpowiedzi `/multi` (właściciel wkleił jej
 * treść z podglądu ruchu w swojej przeglądarce). To nie jest tabela z nagłówkiem, tylko lista
 * "etykieta: wartość" powtórzona dla każdego kontenera — pierwsza wersja odczytu szukała tabeli
 * i dlatego nie miała czego znaleźć.
 *
 * Lista jest zamknięta ŚWIADOMIE: dzięki niej wiadomo, gdzie kończy się wartość jednego pola,
 * a zaczyna następne. Wartości bywają puste ("Time Out:" tuż przed kolejną etykietą) i bywają
 * wielowyrazowe ("DSK Number: 26BOUG3RE 2026-09-02 06:00"), więc bez znajomości etykiet nie da
 * się ich rozdzielić.
 */
const KARTA_LABELS = [
  "Unit Nbr", "Category", "Line Operator", "ISO Type", "Frght Kind",
  "Inbound Carrier", "Outbound Carrier", "Time In", "Time Out", "*Stops",
  "DSK Number", "CEN Number", "Commodity Weight [KG]", "Cargo Weight [KG]", "Weight [KG]",
  "Class", "POD", "Inbound Mode", "Carrier Seal", "Shipper Seal", "Customs Seal", "Vet Seal",
  "T-State", "OH (cm)", "OL-B (cm)", "OL-F (cm)", "OW-L (cm)", "OW-R (cm)",
  // Warianty z KARTY BCT (przepisane z prawdziwej odpowiedzi — patrz fixtures/bct-*.txt).
  // Oba terminale chodzą na Navisie N4, więc rubryki są te same; różni je wielkość liter w „[kg]",
  // brak gwiazdki przy „Stops" oraz nazwy plomb i ponadgabarytów. Dopasowanie jest CASE-SENSITIVE
  // (żeby „POD" nie łapało się w „Podróż"), więc oba zapisy muszą stać na liście osobno.
  "Commodity Weight [kg]", "Cargo Weight [kg]", "Weight [kg]", "Stops",
  "Seal 1", "Seal 2", "Seal 3", "Seal 4", "Seal 5", "Seal 6",
  "OH-B (cm)", "OH-F (cm)", "OH-L (cm)", "OH-R (cm)",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wzorzec etykiet, NAJDŁUŻSZE NAJPIERW. To nie jest kosmetyka: "Cargo Weight [KG]" zawiera w sobie
 * "Weight [KG]", więc przy odwrotnej kolejności waga TOWARU zostałaby odczytana jako waga brutto —
 * a ta z terminala nadpisuje zlecenie, więc byłby to cichy błąd na dokumencie przewozowym.
 */
const ETYKIETA_Z_DWUKROPKIEM = new RegExp(
  `(${[...KARTA_LABELS].sort((a, b) => b.length - a.length).map(escapeRegex).join("|")})\\s*:`,
  "g",
);

/**
 * Ta sama lista, ale BEZ wymaganego dwukropka — tak wygląda karta BCT, gdzie etykieta i wartość
 * siedzą w dwóch komórkach tabeli, więc w tekście strony rozdziela je sam odstęp. Zamiast
 * dwukropka pilnuje nas granica z prawej: bez niej „Class" łapałoby się w środku dłuższego wyrazu.
 */
const ETYKIETA_BEZ_DWUKROPKA = new RegExp(
  `(${[...KARTA_LABELS].sort((a, b) => b.length - a.length).map(escapeRegex).join("|")})\\s*:?(?![\\w-])`,
  "g",
);

/**
 * Wycina kartę JEDNEGO kontenera. Odpowiedź niesie karty wszystkich kontenerów z paczki naraz,
 * więc bez tego cięcia każde zlecenie dostałoby wartości pierwszego z brzegu.
 */
export function wytnijKarte(tekst: string, numer: string): string | null {
  const szukany = key(numer);
  const poczatki: { pozycja: number; numer: string }[] = [];
  for (const m of tekst.matchAll(/Unit Nbr\s*:\s*([A-Z]{4}\s*\d{6,7})/g)) {
    poczatki.push({ pozycja: m.index ?? 0, numer: key(m[1]) });
  }
  const i = poczatki.findIndex((p) => p.numer === szukany);
  if (i < 0) return null;

  // Karta kończy się na PIERWSZYM z tego, co po niej następuje. Sama "Unit Nbr" następnej karty
  // nie wystarczy: między kartami stoi jeszcze stopka strony ("* OOG Hold — …") i nagłówek
  // "Karta kontenera <numer>", a bez tego cięcia wsiąkały one w wartość ostatniego pola.
  const od = poczatki[i].pozycja;
  const dalej = tekst.slice(od + 1);
  const granice = [
    i + 1 < poczatki.length ? poczatki[i + 1].pozycja - (od + 1) : -1,
    dalej.search(/\*\s/),           // stopka strony; "*Stops:" nie pasuje, bo nie ma tam spacji
    dalej.search(/Karta kontenera/i),
    dalej.search(/Brak wynik/i),
  ].filter((n) => n >= 0);

  const koniec = granice.length ? od + 1 + Math.min(...granice) : tekst.length;
  return tekst.slice(od, koniec);
}

/** Karta → pary etykieta/wartość. Pusta wartość ZOSTAJE pustym tekstem (patrz wyżej). */
export function paryZKarty(karta: string, dwukropek = true): Record<string, string> {
  const trafienia = [...karta.matchAll(dwukropek ? ETYKIETA_Z_DWUKROPKIEM : ETYKIETA_BEZ_DWUKROPKA)];
  const pary: Record<string, string> = {};
  trafienia.forEach((m, i) => {
    const od = (m.index ?? 0) + m[0].length;
    const nastepna = i + 1 < trafienia.length ? trafienia[i + 1].index ?? karta.length : karta.length;
    pary[m[1]] = karta.slice(od, nastepna).trim();
  });
  return pary;
}

/**
 * Czy odpowiedź wprost mówi, że NIE ZNA tego kontenera ("Brak wyników dla: CAAU2300808").
 * Sprawdzamy z numerem, bo w jednej odpowiedzi bywają i karty, i takie komunikaty — bez tego
 * jeden nieznany kontener kasowałby wynik pozostałych z paczki.
 */
export function brakWynikowDla(tekst: string, numer: string): boolean {
  const szukany = key(numer);
  // Numer musi stać TUŻ ZA dwukropkiem. Pierwsza wersja przeszukiwała 40 znaków dalej i przez to
  // "Brak wyników dla: CAAU2300808" zabierało numer z NASTĘPNEJ karty — sąsiedni kontener
  // wychodził jako nieznany, choć jego karta stała obok. Złapane testem na prawdziwej odpowiedzi.
  // `[^:]`, nie `\w`: `\w` to wyłącznie [A-Za-z0-9_], więc na "wyników" się wykładało.
  for (const m of tekst.matchAll(/Brak wynik[^:]{0,20}:\s*([A-Z]{4}\s*\d{6,7})/gi)) {
    if (key(m[1]) === szukany) return true;
  }
  return false;
}

/**
 * Odczyt odpowiedzi terminala dla JEDNEGO kontenera. Odpowiedź niesie CAŁĄ PACZKĘ (pytamy
 * o dziesięć naraz), więc najpierw wycinamy kartę z naszym numerem.
 */
export function parseContainerPage(html: string, containerNumber: string): ParsedContainer {
  const text = stripTags(html);

  // 1. Terminal wprost mówi, że nie zna tego kontenera. To nie jest błąd odczytu.
  if (brakWynikowDla(text, containerNumber)) {
    return {
      ...PUSTE,
      notFound: true, recognised: true,
      details: { _container: containerNumber, _uklad: "brak wyników" },
    };
  }

  // 2. Karta kontenera — układ, który terminal faktycznie zwraca.
  const karta = wytnijKarte(text, containerNumber);
  if (karta) {
    const pary = paryZKarty(karta);
    if (Object.keys(pary).length >= 3) {
      return { ...interpretRow(pary), details: { ...pary, _container: containerNumber, _uklad: "karta" } };
    }
  }

  // 3. Tabela kolumnowa — układ eksportu XLSX, który właściciel pobiera ręcznie. Zostaje jako
  //    druga droga, bo nic nie kosztuje, a ma sprawdzone dopasowanie kolumn.
  const wanted = key(containerNumber);
  const rows = extractTableRows(html);
  const row = rows.find((r) => Object.values(r).some((v) => key(v) === wanted));
  if (row) {
    return { ...interpretRow(row), details: { ...row, _container: containerNumber, _uklad: "tabela" } };
  }

  // 4. Nie rozpoznaliśmy. To NIE jest odpowiedź "nic nie znaleziono" — inaczej byłoby to milczące
  //    skasowanie poprzedniego, dobrego wyniku.
  const reason = PAGE_EXPIRED.test(text)
    ? 'Baltic Hub odrzucił zapytanie — wygasł token sesji (strona "Page Expired"). Zapytanie ' +
      "doszło pod właściwy adres i we właściwej formie, ale serwis wymaga tokenu pobranego " +
      "wcześniej ze strony."
    : undefined;
  return {
    ...PUSTE,
    notFound: false,
    recognised: false,
    reason,
    details: { ...describePage(html, text), _container: containerNumber },
  };
}

// ============================================================
// TRZY TERMINALE — jeden odczyt, trzy układy strony.
//
// Właściciel: „analogicznie dla BCT sprawdzimy stan kontenera tym samym sposobem […] dla GCT będzie
// to […] nasza appka będzie sprawdzać stany na 3 terminalach".
//
// Wszystkie układy są przepisane z PRAWDZIWYCH odpowiedzi (katalog `fixtures/`), nie z domysłu.
// Co je różni:
//   BHub  karta „etykieta: wartość", puste rubryki naprawdę puste,
//   BCT   ta sama karta Navisa, ale w TABELI: etykieta i wartość w dwóch komórkach, bez
//         dwukropka, a „nic tu nie ma" zapisane jako „--". Typ kontenera w starym, liczbowym
//         zapisie ISO („2210" zamiast „22G1"),
//   GCT   inny układ: JEDNA tabela z nagłówkiem, wiersz na kontener, kolumny po polsku.
//         Nie podaje ani wagi, ani armatora — tylko status, typ i daty.
// ============================================================

export type TerminalName = "BHub" | "BCT" | "GCT";

/** Czy tę nazwę terminala umiemy odczytać (reszta „Podjęć" — Poimport, Depot — to nie terminale). */
export function isTerminalName(value: unknown): value is TerminalName {
  return value === "BHub" || value === "BCT" || value === "GCT";
}

/**
 * BCT: karta jednego kontenera w tabeli etykieta|wartość. Wycinamy od nagłówka „Karta kontenera"
 * (przed nim stoi menu strony i zgoda na ciasteczka) do przycisku zamykającego okno.
 */
export function parseBct(text: string, containerNumber: string): ParsedContainer {
  const plaski = stripTags(text);
  if (brakWynikowDla(plaski, containerNumber)) {
    return { ...PUSTE, notFound: true, recognised: true, details: { _container: containerNumber, _uklad: "brak wyników" } };
  }

  const od = plaski.search(/Karta kontenera/i);
  if (od < 0) {
    return {
      ...PUSTE, notFound: false, recognised: false,
      details: { ...describePage(text, plaski), _container: containerNumber, _uklad: "BCT: brak karty" },
    };
  }
  const doKonca = plaski.slice(od);
  const zamkniecie = doKonca.search(/\bZamknij\b/);
  const karta = zamkniecie > 0 ? doKonca.slice(0, zamkniecie) : doKonca;

  // Numer kontenera stoi w NAGŁÓWKU karty, nie w rubryce — BCT nie ma „Unit Nbr". Bez tego
  // sprawdzenia karta poprzedniego kontenera zostałaby zapisana przy cudzym zleceniu.
  if (!key(karta).includes(key(containerNumber))) {
    return {
      ...PUSTE, notFound: false, recognised: false,
      details: { ...describePage(text, plaski), _container: containerNumber, _uklad: "BCT: karta innego kontenera" },
    };
  }

  const pary = paryZKarty(karta, false);
  if (Object.keys(pary).length < 3) {
    return {
      ...PUSTE, notFound: false, recognised: false,
      details: { ...describePage(text, plaski), _container: containerNumber, _uklad: "BCT: nie rozpoznałem rubryk" },
    };
  }
  return { ...interpretRow(pary), details: { ...pary, _container: containerNumber, _uklad: "BCT: karta" } };
}

/**
 * Pola tabeli GCT → WIERSZE. Wyglądało to na dzielenie co `kolumny.length` pól i przez to długo
 * działało — na odpowiedzi o JEDEN kontener.
 *
 * BŁĄD, na który to nie wystarcza (zmierzony na prawdziwej odpowiedzi o dwa kontenery): granicę
 * wiersza niesie ZŁAMANIE LINII, a nie tabulator, więc ostatnia komórka wiersza wchłania numer
 * porządkowy wiersza NASTĘPNEGO. „Data/Czas podjęcia" wychodziło wtedy „2" — czyli appka
 * twierdziła, że kontener został podjęty, choć rubryka była pusta — a kolejne kontenery z paczki
 * przesuwały się o jedno pole i nie dawały się w tabeli odnaleźć. Pytamy GCT paczkami po
 * dziesięć numerów, więc dotyczyło to każdej paczki poza jednoelementową.
 *
 * Złamania linii SĄ TEŻ WEWNĄTRZ komórek (status i stan ładunku, statek i ETA/ETD), więc nie
 * wolno po prostu dzielić po `\n`. Tniemy wyłącznie OSTATNIĄ komórkę wiersza i tylko wtedy, gdy
 * po złamaniu linii zostaje sam numer porządkowy kolejnego wiersza — tekst stopki strony pod
 * ostatnim wierszem tego warunku nie spełnia i zostaje przy komórce.
 */
function wierszeGct(pola: string[], kolumny: string[]): Record<string, string>[] {
  const NUMER_PORZADKOWY = /^([\s\S]*?)\n[ \u00A0]*(\d{1,4})[ \u00A0]*$/;
  const kolejka = [...pola];
  const wiersze: Record<string, string>[] = [];

  while (kolejka.length) {
    const wartosci: string[] = [];
    while (wartosci.length < kolumny.length && kolejka.length) {
      let pole = kolejka.shift() as string;
      if (wartosci.length === kolumny.length - 1) {
        const rozdzielone = NUMER_PORZADKOWY.exec(pole);
        if (rozdzielone) {
          pole = rozdzielone[1];
          kolejka.unshift(rozdzielone[2]);
        }
      }
      wartosci.push(pole);
    }

    const wiersz: Record<string, string> = {};
    kolumny.forEach((nazwa, j) => {
      if (nazwa) wiersz[nazwa] = (wartosci[j] ?? "").replace(/\u00A0/g, " ").trim();
    });
    wiersze.push(wiersz);
  }

  return wiersze;
}

/**
 * GCT: jedna tabela, wiersz na kontener. Czytamy z TEKSTU Z TABULATORAMI, a nie ze sklejonego
 * w jedną linię — tylko tabulator mówi, gdzie kończy się „Status", a zaczyna „Status celny"
 * (obie wartości to wolny tekst ze spacjami). Wartości potrafią mieć w środku ZŁAMANIE LINII
 * (w jednej komórce status i stan ładunku, w innej statek i ETA/ETD), więc wiersz składamy
 * z PÓL rozdzielonych tabulatorem, a nie z linii.
 */
export function parseGct(text: string, containerNumber: string): ParsedContainer {
  const linie = text.split("\n");
  const naglowek = linie.findIndex((l) => l.includes("\t") && /Nr\s+kontenera/i.test(l));
  if (naglowek < 0) {
    const plaski = stripTags(text);
    const nieZna = /nie znaleziono|brak wynik|no results/i.test(plaski);
    return {
      ...PUSTE, notFound: nieZna, recognised: nieZna,
      details: { ...describePage(text, plaski), _container: containerNumber, _uklad: "GCT: brak tabeli" },
    };
  }

  const kolumny = linie[naglowek].split("\t").map((c) => c.trim());
  const pola = linie.slice(naglowek + 1).join("\n").split("\t");
  const szukany = key(containerNumber);

  for (const wiersz of wierszeGct(pola, kolumny)) {
    if (key(wiersz["Nr kontenera"] ?? "") !== szukany) continue;

    // GCT wypisuje kontener, o którym NIC NIE WIE, jako zwykły wiersz ze słowami „brak informacji"
    // w rubryce statusu i resztą pustą (zmierzone na odpowiedzi o dwa kontenery). To nie jest stan
    // kontenera, tylko „nie znam" — bez tego appka zapisałaby „brak informacji" jako status,
    // a PUSTĄ rubrykę podjęcia jako „stoi na terminalu".
    if (/^(brak informacji|nie znaleziono|brak danych)$/i.test((wiersz["Status"] ?? "").trim())) {
      return {
        ...PUSTE, notFound: true, recognised: true,
        details: { ...wiersz, _container: containerNumber, _uklad: "GCT: brak informacji" },
      };
    }

    return { ...interpretRow(wiersz), details: { ...wiersz, _container: containerNumber, _uklad: "GCT: tabela" } };
  }

  // Tabela jest, ale naszego numeru w niej nie ma — terminal go nie zna.
  return {
    ...PUSTE, notFound: true, recognised: true,
    details: { _container: containerNumber, _uklad: "GCT: brak w tabeli", _kolumny: kolumny.join(" | ") },
  };
}

/**
 * Odczyt odpowiedzi WŁAŚCIWEGO terminala. Nieznana nazwa nie jest błędem odczytu, tylko błędem
 * konfiguracji — mówimy to wprost, zamiast czytać stronę cudzym parserem.
 */
export function parseTerminalPage(text: string, containerNumber: string, terminal: string): ParsedContainer {
  if (terminal === "BCT") return parseBct(text, containerNumber);
  if (terminal === "GCT") return parseGct(text, containerNumber);
  if (terminal === "BHub" || !terminal) return parseContainerPage(text, containerNumber);
  return {
    ...PUSTE, notFound: false, recognised: false,
    reason: `Nie znam terminala „${terminal}" — appka umie czytać BHub, BCT i GCT.`,
    details: { _container: containerNumber, _terminal: terminal },
  };
}
