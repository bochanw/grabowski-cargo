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

  function znajdzPole() {
    const form = formularzWynikow();
    if (form) {
      const wForm = [...form.querySelectorAll('input, textarea')]
        .filter((el) => el.type !== 'hidden' && el.offsetParent !== null);
      if (wForm.length) return wForm[0];
    }
    const widoczne = widocznePola();
    const opis = (el) => ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || ''));
    return widoczne.find((el) => /kontener|container|numer|\\bid\\b/i.test(opis(el)))
        || widoczne.find((el) => el.tagName === 'TEXTAREA')
        || widoczne.find((el) => (el.type || 'text') === 'text')
        || null;
  }

  /** Guzik wysyłający — tylko z formularza pola, żeby nie trafić w nawigację. */
  function znajdzGuzik(pole) {
    const zakres = (pole && pole.form) || formularzWynikow();
    if (!zakres) return null;
    const guziki = [...zakres.querySelectorAll('button, input[type=submit]')]
      .filter((b) => b.offsetParent !== null);
    return guziki.find((b) => (b.type || '') === 'submit')
        || guziki.find((b) => /sprawd|szukaj|wyszuk|poka/i.test((b.textContent || b.value || '')))
        || guziki[0] || null;
  }

  /**
   * Właściciel opisał drogę wprost: "wchodzimy na stronę, dajemy pojedyncze zapytanie, wpisujemy
   * kontenery po przecinku". Ten przełącznik trybu trzeba więc kliknąć PRZED wpisaniem — bez tego
   * formularz na numery może być w ogóle nieaktywny.
   */
  function wybierzTrybPojedynczy() {
    const kandydaci = [...document.querySelectorAll('button, a, label, [role=tab], [role=button], li, span')];
    const cel = kandydaci.find((el) => /pojedyncze\\s*zapytanie/i.test((el.textContent || '').replace(/\\s+/g, ' ')));
    if (!cel) return '(nie znalazłem przełącznika „pojedyncze zapytanie”)';
    cel.click();
    return 'kliknięto „' + (cel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) + '”';
  }

  function opiszStrone() {
    return {
      tytul: document.title || '',
      adres: location.href,
      formularze: [...document.querySelectorAll('form')].slice(0, 10)
        .map((f) => (f.getAttribute('method') || 'GET') + ' ' + (f.getAttribute('action') || '-')).join(' | '),
      pola: widocznePola().slice(0, 20).map(opisPola).join(' | '),
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
    const tryb = wybierzTrybPojedynczy();
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
    return JSON.stringify({ tekst: document.body?.innerText || '', ...opiszStrone() });
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
      throw new Error(
        `Na stronie Baltic Hub nie pojawiło się pole na numery kontenerów w ciągu 25 s. ` +
          `Tytuł: „${gotowa.stan.tytul ?? ""}”. Adres: ${gotowa.stan.adres ?? "?"}. ` +
          `Pola: ${gotowa.stan.pola || "(brak)"}. Guziki: ${gotowa.stan.guziki || "(brak)"}. ` +
          `Tekst: ${gotowa.stan.tekst ?? ""}`,
      );
    }

    const wyslane = await odczytaj(cdp, sessionId, skryptWyslania(containers));
    if (!wyslane.wyslane) {
      throw new Error(
        `Nie udało się uruchomić wyszukiwania: ${wyslane.powod ?? "nieznany powód"}. ` +
          `Pola: ${wyslane.pola || "(brak)"}. Guziki: ${wyslane.guziki || "(brak)"}.`,
      );
    }

    const wyniki = await poczekaj(cdp, sessionId, skryptTresci(), (s) => maWyniki(s.tekst ?? ""), 40_000);
    if (!wyniki.ok) {
      throw new Error(
        `Wyszukiwanie uruchomione (${wyslane.sposob}), ale wyniki nie pojawiły się w ciągu 40 s. ` +
          `Tryb: ${wyslane.tryb ?? "?"}. Pole: ${wyslane.pole ?? "?"}. Guzik: ${wyslane.guzik ?? "?"}. ` +
          `Wpisano: „${wyslane.wpisano ?? ""}”. Adres: ${wyniki.stan.adres ?? "?"}. ` +
          `Formularze: ${wyniki.stan.formularze || "(brak)"}. Guziki: ${wyniki.stan.guziki || "(brak)"}. ` +
          `Tekst: ${(wyniki.stan.tekst ?? "").replace(/\s+/g, " ").slice(0, 250)}`,
      );
    }

    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    return wyniki.stan.tekst ?? "";
  } finally {
    cdp.close();
  }
}
