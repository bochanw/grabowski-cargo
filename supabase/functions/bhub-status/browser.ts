// Zdalna przeglądarka Bright Data (Scraping Browser) sterowana protokołem CDP po WebSocket.
//
// ============================ PO CO TO JEST ============================
// Baltic Hub oddaje wyniki dopiero na `POST /multi`, a ten POST wymaga tokenu CSRF z sesji
// (bez niego Laravel odpowiada stroną "Page Expired" — sprawdzone na produkcji). Token trzeba
// najpierw pobrać ze strony i odesłać razem z ciasteczkiem sesji, czyli potrzebne są DWA powiązane
// zapytania. Web Unlocker traktuje każde zapytanie osobno i nie pozwala wysłać własnych ciasteczek,
// więc tą drogą się nie da. Prawdziwa przeglądarka robi to sama, bo po prostu ma sesję.
//
// Eksport XLSX nie jest alternatywą: sprawdzone u właściciela — kliknięcie XLSX NIE wysyła żadnego
// zapytania, plik powstaje w całości w przeglądarce z danych już wczytanych.
//
// ====================== DLACZEGO WŁASNY KLIENT CDP ======================
// Puppeteer i Playwright ciągną za sobą pół Node'a, a potrzebujemy dosłownie czterech poleceń
// protokołu.
//
// Połączenie idzie przez WŁASNEGO klienta WebSocket (wsClient.ts), nie przez wbudowany. Powód
// zmierzony na produkcji: Bright Data wymaga nagłówka `Authorization`, którego wbudowany
// `WebSocket` nie pozwala podać — zostaje wpisanie danych w adresie, a runtime Supabase (inaczej
// niż Deno na zwykłym komputerze) najwyraźniej nie buduje z niego nagłówka Basic. To samo
// uzgodnienie wysłane ręcznie dostaje `HTTP/1.1 101 Switching Protocols`, a wbudowany `WebSocket`
// pod tym samym adresem kończy się błędem BEZ TREŚCI.
//
// ========================= SKĄD OSZCZĘDNOŚĆ =========================
// Rozliczenie idzie za PRZESŁANE DANE (8 USD/GB), więc blokujemy obrazki, czcionki i style —
// do odczytania statusu są niepotrzebne, a to one stanowią większość z ~285 kB strony.
// Jedna sesja przeglądarki obsługuje CAŁY przebieg (wszystkie paczki), nie każdą z osobna.

import { RawWebSocket } from "./wsClient.ts";

const CDP_HOST = "brd.superproxy.io:9222";

/** Zasoby bez wpływu na wynik, a ważące najwięcej — nie pobieramy ich, żeby nie płacić za bajty. */
const BLOCKED = [
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.ico",
  "*.woff", "*.woff2", "*.ttf", "*.otf",
  "*.css", "*.mp4", "*.webm",
  "*google-analytics*", "*googletagmanager*", "*doubleclick*", "*sentry*",
];

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/**
 * Minimalny klient CDP: wysyła polecenia i czeka na odpowiedź o tym samym `id`.
 * Świadomie nie obsługuje niczego ponad to, czego tu używamy.
 */
class CdpSession {
  #ws: RawWebSocket;
  #nextId = 1;
  #oczekujace = new Map<number, { ok: (r: Record<string, unknown>) => void; blad: (e: Error) => void }>();
  #zdarzenia = new Map<string, () => void>();

  private constructor(ws: RawWebSocket) {
    this.#ws = ws;
    ws.onMessage = (tekst) => this.#odbierz(tekst);
    ws.onClose = (powod) => this.#przerwij(new Error(powod));
  }

  static async connect(timeoutMs: number): Promise<CdpSession> {
    const { user, pass } = daneLogowania();
    const [hostname, port] = [CDP_HOST.split(":")[0], Number(CDP_HOST.split(":")[1] ?? 443)];
    // Nagłówek wprost — o to w tym wszystkim chodzi. Adres zostaje czysty, bez danych logowania.
    const ws = await RawWebSocket.connect({
      hostname,
      port,
      path: "/",
      headers: { Authorization: `Basic ${btoa(`${user}:${pass}`)}` },
      timeoutMs,
    });
    return new CdpSession(ws);
  }

  #odbierz(surowe: string) {
    let wiadomosc: CdpMessage;
    try {
      wiadomosc = JSON.parse(surowe);
    } catch {
      return;
    }
    if (wiadomosc.id !== undefined) {
      const czeka = this.#oczekujace.get(wiadomosc.id);
      if (!czeka) return;
      this.#oczekujace.delete(wiadomosc.id);
      if (wiadomosc.error) czeka.blad(new Error(wiadomosc.error.message ?? "błąd protokołu przeglądarki"));
      else czeka.ok(wiadomosc.result ?? {});
      return;
    }
    if (wiadomosc.method) {
      const nasluch = this.#zdarzenia.get(wiadomosc.method);
      if (nasluch) {
        this.#zdarzenia.delete(wiadomosc.method);
        nasluch();
      }
    }
  }

  #przerwij(blad: Error) {
    for (const { blad: odrzuc } of this.#oczekujace.values()) odrzuc(blad);
    this.#oczekujace.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 60_000) {
    const id = this.#nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#oczekujace.delete(id);
        reject(new Error(`Przeglądarka nie odpowiedziała na ${method}.`));
      }, timeoutMs);
      this.#oczekujace.set(id, {
        ok: (r) => { clearTimeout(timer); resolve(r); },
        blad: (e) => { clearTimeout(timer); reject(e); },
      });
      // Nieudany zapis musi odrzucić TO polecenie, a nie zawisnąć do upływu limitu czasu.
      this.#ws
        .send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        .catch((e) => {
          this.#oczekujace.delete(id);
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
  }

  /** Czeka na pojedyncze zdarzenie protokołu (np. załadowanie strony). */
  once(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#zdarzenia.delete(method);
        // Brak zdarzenia nie jest błędem: strona bywa "gotowa" wcześniej, a i tak sprawdzamy
        // dalej, czy da się z niej odczytać token.
        resolve();
      }, timeoutMs);
      this.#zdarzenia.set(method, () => { clearTimeout(timer); resolve(); });
    });
  }

  close() {
    try { this.#ws.close(); } catch { /* nie szkodzi */ }
  }
}

function daneLogowania(): { user: string; pass: string } {
  const user = Deno.env.get("BRIGHTDATA_BROWSER_USER");
  const pass = Deno.env.get("BRIGHTDATA_BROWSER_PASSWORD");
  if (!user || !pass) {
    throw new Error(
      "Brak konfiguracji zdalnej przeglądarki — uzupełnij sekrety BRIGHTDATA_BROWSER_USER " +
        "i BRIGHTDATA_BROWSER_PASSWORD (Project Settings → Edge Functions → Secrets)."
    );
  }
  return { user, pass };
}

/**
 * Wspólny kawałek skryptów działających W PRZEGLĄDARCE.
 *
 * KOTWICA to formularz wysyłający na `/multi` — ten adres znamy z podglądu prawdziwego ruchu
 * w przeglądarce właściciela, więc jest twardym faktem, a nie zgadywaniem. Dopiero gdy takiego
 * formularza nie ma, szukamy luźniej. Pierwsza wersja szukała OD RAZU luźno i skończyło się tak,
 * że kliknęła prawdopodobnie w pozycję menu "Sprawdź kontener online" — strona ani drgnęła.
 *
 * Guzik bierzemy WYŁĄCZNIE z tego samego formularza co pole (albo `type=submit`), nigdy z całej
 * strony: w nawigacji Baltic Hubu stoi napis "Sprawdź kontener online", który łapał się na to
 * samo dopasowanie co guzik formularza.
 */
// UWAGA na ukośniki: to szablon tekstowy, więc `\s` znaczy w nim samo "s". Każdy wzorzec musi
// mieć PODWÓJNY ukośnik (`\\s`), inaczej `\\s*` wychodzi jako `s*`, a `replace(/\\s+/g,' ')`
// zaczyna wycinać ze strony litery "s". Złapane testem, nie przy pisaniu.
const POMOCNIKI = `
  const widocznePola = () => [...document.querySelectorAll('input, textarea')]
    .filter((el) => el.type !== 'hidden' && el.offsetParent !== null);
  const opisPola = (el) => !el ? '(brak)' :
    (el.tagName + '[' + (el.type || '') + '] name=' + (el.name || '-') + ' id=' + (el.id || '-') +
     ' podpowiedz=' + (el.placeholder || '-') + ' formularz=' + ((el.form && el.form.getAttribute('action')) || '-'));
  const opisGuzika = (b) => !b ? '(brak)' :
    ((b.tagName || '') + '[' + (b.type || '') + '] „' + ((b.textContent || b.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40) + '”'));

  /** Formularz wysyłający na /multi — kotwica z prawdziwego ruchu. */
  function formularzWynikow() {
    return [...document.querySelectorAll('form')].find((f) => /multi/i.test(f.getAttribute('action') || '')) || null;
  }

  /**
   * Pole na numery. Wykluczenia są tu WAŻNIEJSZE niż dopasowania — zmierzone na produkcji:
   *  - typy nietekstowe: pierwsza wersja wpisała numery w PRZYCISK RADIOWY 'name=seacontainer';
   *  - pola wyszukiwarki serwisu: jedyne formularze na tej stronie to dwa razy 'GET /search',
   *    a formularza na /multi NIE MA W OGÓLE (numery wysyła JavaScript, nie formularz).
   */
  const TYPY_TEKSTOWE = ['text', 'search', 'tel', 'url', 'email', ''];
  function polaTekstowe() {
    return widocznePola().filter((el) =>
      el.tagName === 'TEXTAREA' || TYPY_TEKSTOWE.includes((el.type || 'text').toLowerCase()));
  }
  function znajdzPole() {
    const opis = (el) => ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || ''));
    const szukajkaSerwisu = (el) => /search|szukaj/i.test(((el.form && el.form.getAttribute('action')) || '') + ' ' + opis(el));

    const kandydaci = polaTekstowe();
    const poza = kandydaci.filter((el) => !szukajkaSerwisu(el));
    return poza.find((el) => /kontener|container|unit|numer/i.test(opis(el)))
        || poza.find((el) => el.tagName === 'TEXTAREA')
        || poza[0]
        || kandydaci.find((el) => /kontener|container|unit/i.test(opis(el)))
        || null;
  }

  /**
   * Guzik uruchamiający wyszukiwanie. Formularza na /multi nie ma, więc nie ma się czym ograniczyć
   * — rozstrzyga KRÓTKI, dokładny napis. W nawigacji stoi "Sprawdź kontener online" (długie),
   * a nagłówki tabeli wyników to "Unit Number", "ISO Type" itd.; jedno i drugie łapało się na
   * luźne dopasowanie i klik nie robił nic.
   */
  function znajdzGuzik(pole) {
    const zakres = (pole && pole.form) || document;
    const wszystkie = [...zakres.querySelectorAll('button, input[type=submit], input[type=button], a')]
      .filter((b) => b.offsetParent !== null);
    const napis = (b) => (b.textContent || b.value || '').replace(/\\s+/g, ' ').trim();

    return wszystkie.find((b) => (b.type || '') === 'submit' && !/search|szukaj/i.test(((b.form && b.form.getAttribute('action')) || '')))
        || wszystkie.find((b) => /^(sprawd\\S*|szukaj|wyszukaj|poka\\S*)$/i.test(napis(b)))
        || wszystkie.find((b) => napis(b).length <= 24 && /sprawd|wyszuk/i.test(napis(b)) && !/online/i.test(napis(b)))
        || null;
  }

  /**
   * Tryb zapytania NIE JEST przez nas przestawiany — tylko opisywany.
   *
   * Powód z produkcji: radio 'seacontainer' ma dwie opcje i strona sama zaznacza właściwą.
   * Poprzednia wersja "pomocnie" klikała każdą odznaczoną, która pasowała do nazwy, i przestawiła
   * tryb na 'multi', psując domyślny wybór. Zbyt gorliwy automat zrobił tu więcej szkody niż
   * pożytku; jeśli kiedyś trzeba będzie wybrać konkretną opcję, zrobimy to po jej WARTOŚCI,
   * a nie po samej nazwie grupy.
   */
  function opiszTryb() {
    const radia = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
    if (!radia.length) return '(brak przełączników)';
    return radia.map((r) => (r.name || '?') + '=' + (r.value || '?') + (r.checked ? ' [zaznaczone]' : ''))
      .join(', ');
  }

  function opiszStrone() {
    return {
      tytul: document.title || '',
      adres: location.href,
      formularze: [...document.querySelectorAll('form')].slice(0, 10)
        .map((f) => (f.getAttribute('method') || 'GET') + ' ' + (f.getAttribute('action') || '-')).join(' | '),
      pola: [...document.querySelectorAll('input, textarea, select')].slice(0, 30)
        .map((el) => opisPola(el) + (el.type === 'radio' || el.type === 'checkbox' ? (el.checked ? ' [zaznaczone]' : ' [odznaczone]') : '')
          + (el.offsetParent === null ? ' [niewidoczne]' : '')).join(' | '),
      guziki: [...document.querySelectorAll('button, input[type=submit]')].slice(0, 20)
        .map((b) => (b.textContent || b.value || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | '),
      tekst: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    };
  }
`;

/** Czy strona jest już gotowa do wypełnienia (przeszła przejściówkę Cloudflare i ma pole). */
export function skryptStanuStrony(): string {
  return `(() => {${POMOCNIKI}
    const pole = znajdzPole();
    return JSON.stringify({ gotowa: Boolean(pole), ...opiszStrone() });
  })()`;
}

/**
 * Wypełnia pole numerami i URUCHAMIA WYSZUKIWANIE tak, jak zrobiłby to człowiek: najpierw wybiera
 * tryb "pojedyncze zapytanie", potem wpisuje numery, potem klika guzik FORMULARZA.
 *
 * Wartość ustawiamy przez ustawiacz z prototypu, bo strony pisane w Reakcie/Vue nie zauważają
 * zwykłego przypisania do `value` i przy wysyłce widzą pole puste.
 *
 * Do wyniku wpisujemy, CO dokładnie zostało kliknięte i wypełnione. Bez tego "kliknięto guzik,
 * a strona nie drgnęła" nie mówi nic o tym, w co się kliknęło — kosztowało to jedną rundę.
 */
export function skryptWyslania(containers: string[]): string {
  return `(() => {${POMOCNIKI}
    const tryb = opiszTryb();
    const pole = znajdzPole();
    if (!pole) return JSON.stringify({ wyslane: false, powod: 'nie znalazłem pola na numery', tryb, ...opiszStrone() });

    const wartosc = ${JSON.stringify(containers.join(", "))};
    const ustawiacz = Object.getOwnPropertyDescriptor(pole.constructor.prototype, 'value')?.set;
    if (ustawiacz) ustawiacz.call(pole, wartosc); else pole.value = wartosc;
    pole.dispatchEvent(new Event('input', { bubbles: true }));
    pole.dispatchEvent(new Event('change', { bubbles: true }));

    const guzik = znajdzGuzik(pole);
    const uzyte = { tryb, pole: opisPola(pole), guzik: opisGuzika(guzik), wpisano: pole.value };

    if (guzik) { guzik.click(); return JSON.stringify({ wyslane: true, sposob: 'klik w guzik formularza', ...uzyte }); }
    const form = pole.form || formularzWynikow();
    if (form && form.requestSubmit) { form.requestSubmit(); return JSON.stringify({ wyslane: true, sposob: 'requestSubmit', ...uzyte }); }
    if (form) { form.submit(); return JSON.stringify({ wyslane: true, sposob: 'form.submit', ...uzyte }); }
    pole.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    return JSON.stringify({ wyslane: true, sposob: 'Enter', ...uzyte });
  })()`;
}

/** Widoczny tekst strony — z niego czytamy karty kontenerów (patrz parse.ts). */
export function skryptTresci(): string {
  return `(() => {${POMOCNIKI}
    return JSON.stringify({
      tekst: document.body?.innerText || '',
      // Otoczenie POLA, nie początek strony: pierwsza wersja brała pierwsze 60 tys. znaków
      // dokumentu i formularz w ogóle się w nich nie zmieścił.
      html: (() => {
        const pole = znajdzPole();
        let el = pole;
        for (let i = 0; i < 6 && el && el.parentElement; i++) el = el.parentElement;
        return ((el && el.outerHTML) || document.body?.innerHTML || '').slice(0, 40000);
      })(),
      ...opiszStrone(),
    });
  })()`;
}

/** Odpowiedź jest gotowa, gdy widać karty albo jawne "brak wyników". */
export function maWyniki(tekst: string): boolean {
  return /Karta kontenera|Brak wynik/i.test(tekst);
}

async function odczytaj(cdp: CdpSession, sessionId: string, skrypt: string): Promise<Record<string, string>> {
  const wynik = (await cdp.send(
    "Runtime.evaluate",
    { expression: skrypt, returnByValue: true },
    sessionId,
    30_000,
  )) as { result?: { value?: string } };
  return JSON.parse(wynik.result?.value ?? "{}") as Record<string, string>;
}

/**
 * Czeka, aż coś na stronie będzie prawdą — używane dwa razy: na gotowość formularza i na wyniki.
 * Zwraca ostatni odczyt także przy niepowodzeniu, żeby było CO wpisać w komunikat błędu.
 */
async function poczekaj(
  cdp: CdpSession,
  sessionId: string,
  skrypt: string,
  gotowe: (stan: Record<string, string>) => boolean,
  msLimit: number,
): Promise<{ ok: boolean; stan: Record<string, string> }> {
  const koniec = Date.now() + msLimit;
  let stan: Record<string, string> = {};
  for (;;) {
    stan = await odczytaj(cdp, sessionId, skrypt);
    if (gotowe(stan)) return { ok: true, stan };
    if (Date.now() > koniec) return { ok: false, stan };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Otwiera stronę Baltic Hub, wpisuje numery kontenerów i uruchamia wyszukiwanie — a potem czyta
 * widoczny tekst wyników. Kluczowe jest to, że robi to PRZEGLĄDARKA: ma sesję, ciasteczka i token,
 * i wysyła dokładnie takie zapytanie, jakie serwis rozumie.
 */
/**
 * Prosi zdalną przeglądarkę o ROZWIĄZANIE reCAPTCHY.
 *
 * Formularz Baltic Hubu jest nią chroniony — w spisie pól strony stoi `g-recaptcha-response`
 * (ukryte pole i textarea). Dopóki jest puste, serwis nie odda wyników, choćby pole i guzik
 * były trafione idealnie; tak właśnie kończyły się poprzednie przebiegi.
 *
 * `Captcha.solve` to polecenie DODANE przez Bright Datę do protokołu przeglądarki, nie część
 * standardu — dlatego zwykły Chrome go nie zna i dlatego trzeba je wywołać wprost. Niepowodzenie
 * NIE przerywa przebiegu: bywa, że zagadka w ogóle się nie pojawia, a wtedy brak solvera nie jest
 * błędem. To, co się wydarzyło, trafia do migawki.
 */
async function rozwiazZagadke(cdp: CdpSession, sessionId: string): Promise<string> {
  try {
    const wynik = (await cdp.send(
      "Captcha.solve",
      { detectTimeout: 25_000 },
      sessionId,
      40_000,
    )) as { status?: string; error?: string };
    return `Captcha.solve: ${wynik.status ?? "?"}${wynik.error ? ` (${wynik.error})` : ""}`;
  } catch (e) {
    return `Captcha.solve nie zadziałało: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Błąd z MIGAWKĄ strony. Komunikat musi zostać krótki, bo trafia do `bhub_error`, a każda jego
 * zmiana ląduje w dzienniku zmian; kod strony jest za duży, więc idzie osobno do `bhub_details`,
 * które trigger dziennika pomija.
 */
export function bladZeSzczegolami(komunikat: string, szczegoly: Record<string, string>): Error {
  const e = new Error(komunikat) as Error & { szczegoly?: Record<string, string> };
  e.szczegoly = szczegoly;
  return e;
}

export async function fetchViaBrowser(
  pageUrl: string,
  _postUrl: string,
  containers: string[],
): Promise<string> {
  // Powód niepowodzenia niesie już sam klient WebSocket (kod odpowiedzi i treść od serwera),
  // więc nie ma tu osobnej diagnozy połączenia.
  const cdp = await CdpSession.connect(30_000);

  try {
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Network.setBlockedURLs", { urls: BLOCKED }, sessionId);

    const zaladowana = cdp.once("Page.loadEventFired", 45_000);
    await cdp.send("Page.navigate", { url: pageUrl }, sessionId, 60_000);
    await zaladowana;

    // Pierwsze wejście trafia zwykle na przejściówkę Cloudflare — zdarzenie "strona wczytana"
    // pada wtedy dla NIEJ, nie dla właściwej strony. Czekamy więc na pole, nie na zdarzenie.
    const gotowa = await poczekaj(cdp, sessionId, skryptStanuStrony(), (s) => Boolean(s.gotowa), 25_000);
    if (!gotowa.ok) {
      throw bladZeSzczegolami(
        `Na stronie Baltic Hub nie pojawiło się pole na numery kontenerów w ciągu 25 s. ` +
          `Tytuł: „${gotowa.stan.tytul ?? ""}”. Migawka strony zapisana do diagnozy.`,
        { _etap: "brak pola na numery", ...gotowa.stan },
      );
    }

    // Zagadkę rozwiązujemy PRZED wpisaniem numerów: jej rozwiązanie wpisuje się w ukryte pole
    // formularza, a niektóre serwisy zerują je przy przeładowaniu widoku.
    const zagadka = await rozwiazZagadke(cdp, sessionId);

    const wyslane = await odczytaj(cdp, sessionId, skryptWyslania(containers));
    if (!wyslane.wyslane) {
      throw bladZeSzczegolami(
        `Nie udało się uruchomić wyszukiwania: ${wyslane.powod ?? "nieznany powód"}. ` +
          `Tryb: ${wyslane.tryb ?? "?"}. Migawka strony zapisana do diagnozy.`,
        { _etap: "nie udało się uruchomić wyszukiwania", _zagadka: zagadka, ...wyslane },
      );
    }

    const wyniki = await poczekaj(cdp, sessionId, skryptTresci(), (s) => maWyniki(s.tekst ?? ""), 35_000);
    if (!wyniki.ok) {
      throw bladZeSzczegolami(
        // Krótko, bo `bhub_error` trafia do dziennika zmian. Komplet (spis pól, guziki, kod
        // strony) idzie do migawki obok, której dziennik nie zapisuje.
        `Wyszukiwanie uruchomione (${wyslane.sposob}), ale wyniki nie pojawiły się w ciągu 35 s. ` +
          `Tryb: ${wyslane.tryb ?? "?"}. Pole: ${wyslane.pole ?? "?"}. Guzik: ${wyslane.guzik ?? "?"}. ` +
          `Zagadka: ${zagadka}. Migawka strony zapisana do diagnozy.`,
        { _etap: "brak wyników", _zagadka: zagadka, ...wyslane, ...wyniki.stan },
      );
    }

    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    return wyniki.stan.tekst ?? "";
  } finally {
    cdp.close();
  }
}
