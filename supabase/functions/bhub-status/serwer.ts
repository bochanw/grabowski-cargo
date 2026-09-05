// ============================================================
// POBIERANIE STATUSÓW WPROST Z SERWERA — dla terminali, które NIE wymagają logowania ani nie
// bronią się przed automatami.
//
// Podział ustalony z właścicielem:
//   BHub i strony wymagające logowania  → rozszerzenie do Chrome (przeglądarka dyspozytora),
//   strony publiczne (BCT, GCT)         → ta droga, a rozszerzenie zostaje jako zabezpieczenie.
//
// Zysk jest konkretny: statusy odświeżają się co kwadrans same, choćby nikt nie miał włączonego
// komputera, i znika połowa powodów, dla których droga przez przeglądarkę bywa krucha
// (`chrome.debugger`, okno zgody na ciasteczka, reCAPTCHA, wyścig z wczytywaniem strony).
//
// DLACZEGO TO NIE JEST TA SAMA ŚCIANA, O KTÓRĄ ROZBIŁ SIĘ BALTIC HUB: oba terminale też wymagają
// tokenu z wcześniej pobranej strony (BCT — `__RequestVerificationToken` ASP.NET, GCT —
// `PRADO_PAGESTATE`), czyli wyglądają jak „Page Expired" z `/multi`. Różnica jest rozstrzygająca:
// tam Cloudflare nie pozwalał w ogóle POBRAĆ strony, więc świeżego tokenu nie dało się zdobyć.
// Tu zwykły GET przechodzi, więc token jest formalnością.
//
// Wszystko poniżej jest ZMIERZONE na prawdziwych odpowiedziach (fixtures/*.html), nie założone.
// ============================================================

import { htmlToText } from "./htmlText.ts";

/** Ile kontenerów mieści się w JEDNYM zapytaniu do terminala. */
export const PACZKA: Record<string, number> = {
  // BCT przyjmuje kilka numerów po przecinku i faktycznie je przetwarza (sprawdzone: przy
  // „nieznany, znany" oddał kartę tego znanego). ZOSTAJEMY PRZY JEDNYM, bo kontener, którego
  // terminal nie zna, znika z odpowiedzi BEZ ŚLADU — nie ma ani karty, ani zdania „brak wyników".
  // Przy pytaniu zbiorczym nie dałoby się odróżnić „terminal go nie zna" od „nie odczytałem
  // odpowiedzi", a to jest różnica między spokojnym wpisem a alarmem dla dyspozytora.
  BCT: 1,
  // GCT sam zaprasza do pytania zbiorczego („max. 242 znaków") i oddaje WIERSZ NA KONTENER,
  // a o nieznanym pisze wprost „brak informacji" — czyli nic się nie gubi po cichu.
  GCT: 10,
};

/** Terminale obsługiwane z serwera. BHub tu nie należy i nigdy nie należał — patrz nagłówek. */
export function obslugiwanyZSerwera(terminal: string): boolean {
  return terminal === "BCT" || terminal === "GCT";
}

const ADRESY: Record<string, string> = {
  BCT: "https://ebrama.bct.ictsi.com/vbs-check-container",
  GCT: "https://terminal.gct.pl/?page=90039_PublicCntrStatus.Report90039Page",
};

const BCT_SUBMIT = "https://ebrama.bct.ictsi.com/Tiles/TileCheckContainerSubmit";

// Zwykła przeglądarka. Nie po to, żeby się podszywać — te strony są publiczne i nie mają
// captchy — tylko dlatego, że część serwerów odmawia klientom bez `User-Agent`.
const PRZEGLADARKA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const LIMIT_CZASU_MS = 25_000;

export interface OdpowiedzTerminala {
  /** Treść strony w kształcie, jaki przysyła rozszerzenie (`innerText`) — patrz `htmlText.ts`. */
  tekst: string;
  adres: string;
  dlugoscHtml: number;
}

/** Ciasteczka z odpowiedzi → nagłówek `Cookie` do następnego zapytania (fetch ich nie pamięta). */
function ciasteczka(odpowiedz: Response, dotychczasowe = ""): string {
  const zebrane = new Map<string, string>();
  for (const wpis of dotychczasowe.split("; ")) {
    const rowna = wpis.indexOf("=");
    if (rowna > 0) zebrane.set(wpis.slice(0, rowna), wpis.slice(rowna + 1));
  }
  const naglowki = typeof odpowiedz.headers.getSetCookie === "function"
    ? odpowiedz.headers.getSetCookie()
    : [odpowiedz.headers.get("set-cookie") ?? ""];
  for (const surowe of naglowki) {
    const pierwsze = (surowe ?? "").split(";")[0];
    const rowna = pierwsze.indexOf("=");
    if (rowna > 0) zebrane.set(pierwsze.slice(0, rowna).trim(), pierwsze.slice(rowna + 1).trim());
  }
  return [...zebrane].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function pobierz(adres: string, opcje: RequestInit): Promise<Response> {
  const odpowiedz = await fetch(adres, {
    ...opcje,
    signal: AbortSignal.timeout(LIMIT_CZASU_MS),
    headers: { "User-Agent": PRZEGLADARKA, "Accept-Language": "pl-PL,pl;q=0.9", ...(opcje.headers ?? {}) },
  });
  if (!odpowiedz.ok) {
    throw new Error(`${adres} odpowiedział ${odpowiedz.status} ${odpowiedz.statusText}.`);
  }
  return odpowiedz;
}

/** Wyciąga wartość ukrytego pola formularza. Brak = strona wygląda inaczej, niż się spodziewamy. */
function ukrytePole(html: string, nazwa: string): string {
  const wzorzec = new RegExp(`name=["']${nazwa}["'][^>]*value=["']([^"']*)["']`, "i");
  const odwrotnie = new RegExp(`value=["']([^"']*)["'][^>]*name=["']${nazwa}["']`, "i");
  const trafienie = wzorzec.exec(html) ?? odwrotnie.exec(html);
  if (!trafienie) {
    throw new Error(
      `Nie znalazłem pola „${nazwa}" na stronie terminala — układ strony się zmienił albo zamiast ` +
        `formularza przyszło coś innego (${html.length} znaków).`,
    );
  }
  return trafienie[1];
}

/**
 * BCT (ASP.NET). Formularz siedzi pod `/vbs-check-container`, ale wyniki oddaje osobny adres
 * `/Tiles/TileCheckContainerSubmit` wołany AJAX-em — i to jego pytamy wprost, zamiast udawać
 * kliknięcie. Token antyfałszerski i ciasteczko sesji z pierwszego GET-a DAJĄ SIĘ UŻYĆ PONOWNIE
 * dla kolejnych kontenerów (sprawdzone), więc paczka N kontenerów to 1 + N zapytań, nie 2N.
 */
async function pobierzBct(numery: string[], sesja: { token?: string; cookie?: string }): Promise<string> {
  if (!sesja.token) {
    const formularz = await pobierz(ADRESY.BCT, { method: "GET" });
    const html = await formularz.text();
    sesja.cookie = ciasteczka(formularz);
    sesja.token = ukrytePole(html, "__RequestVerificationToken");
  }

  const dane = new URLSearchParams();
  dane.set("__RequestVerificationToken", sesja.token);
  dane.set("ContainerNo", numery.join(", "));

  const wynik = await pobierz(BCT_SUBMIT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: ADRESY.BCT,
      ...(sesja.cookie ? { Cookie: sesja.cookie } : {}),
    },
    body: dane.toString(),
  });
  return await wynik.text();
}

/**
 * GCT (PRADO). Ta sama strona przyjmuje POST z `PRADO_PAGESTATE` z poprzedniego wczytania.
 * Stan strony jest JEDNORAZOWY — pobieramy go dla każdej paczki od nowa.
 */
async function pobierzGct(numery: string[]): Promise<string> {
  const formularz = await pobierz(ADRESY.GCT, { method: "GET" });
  const html = await formularz.text();
  const cookie = ciasteczka(formularz);
  const stan = ukrytePole(html, "PRADO_PAGESTATE");

  const dane = new URLSearchParams();
  dane.set("PRADO_PAGESTATE", stan);
  dane.set("ctl0$Main$CntrIDsTextBox", numery.join(" "));
  dane.set("ctl0$Main$ShowButton", "Pokaż");

  const wynik = await pobierz(ADRESY.GCT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: ADRESY.GCT,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: dane.toString(),
  });
  return await wynik.text();
}

/**
 * Pobiera stronę z wynikami dla paczki kontenerów. Zwraca tekst w kształcie `innerText`, czyli
 * dokładnie taki, jaki przysyła rozszerzenie — dalej czyta go TEN SAM `parse.ts`.
 *
 * `sesja` pozwala BCT nie pobierać tokenu przed każdym kontenerem; dla GCT jest bez znaczenia.
 */
export async function pobierzZTerminala(
  terminal: string,
  numery: string[],
  sesja: { token?: string; cookie?: string } = {},
): Promise<OdpowiedzTerminala> {
  if (!obslugiwanyZSerwera(terminal)) {
    throw new Error(`Terminala ${terminal} nie odpytujemy z serwera — ten należy do rozszerzenia.`);
  }
  const html = terminal === "BCT" ? await pobierzBct(numery, sesja) : await pobierzGct(numery);

  // Pusta odpowiedź to NIE „strona bez danych" — to awaria, którą trzeba nazwać. Ta sama pułapka
  // zdarzyła się już raz przy Bright Dacie: 200 i zero znaków udawało spokojny brak wyników.
  if (!html.trim()) {
    throw new Error(`${terminal} oddał PUSTĄ odpowiedź (0 znaków) z ${ADRESY[terminal]}.`);
  }

  return { tekst: htmlToText(html), adres: ADRESY[terminal], dlugoscHtml: html.length };
}

/** Numery w paczkach o rozmiarze właściwym dla terminala. */
export function paczki(terminal: string, numery: string[]): string[][] {
  const rozmiar = PACZKA[terminal] ?? 1;
  const wynik: string[][] = [];
  for (let i = 0; i < numery.length; i += rozmiar) wynik.push(numery.slice(i, i + rozmiar));
  return wynik;
}
