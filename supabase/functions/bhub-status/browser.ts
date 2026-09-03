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

interface Token {
  csrf: string;
  xsrf: string;
}

/**
 * Skrypt wykonywany W PRZEGLĄDARCE: wysyła zapytanie o kontenery z wnętrza strony, dzięki czemu
 * ciasteczko sesji dokłada się samo.
 *
 * Nagłówki tokenu wysyłamy WSZYSTKIE, które udało się znaleźć. Laravel przyjmuje token na trzy
 * sposoby (pole `_token` w treści, `X-CSRF-TOKEN` z meta, `X-XSRF-TOKEN` z ciasteczka) i sprawdza
 * je po kolei; nadmiarowy nagłówek nic nie psuje, a brak tego jedynego właściwego kosztowałby
 * kolejną rundę.
 */
export function skryptZapytania(token: Token, postUrl: string, containers: string[]): string {
  return `(async () => {
      const token = ${JSON.stringify(token.csrf)};
      const xsrf = ${JSON.stringify(token.xsrf)};
      const naglowki = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (token) naglowki['X-CSRF-TOKEN'] = token;
      if (xsrf) naglowki['X-XSRF-TOKEN'] = xsrf;
      let body = ${JSON.stringify("lang=pl")} + ${JSON.stringify(containers)}
        .map((c) => '&id%5B%5D=' + encodeURIComponent(c)).join('');
      if (token) body += '&_token=' + encodeURIComponent(token);
      const res = await fetch(${JSON.stringify(postUrl)}, {
        method: 'POST',
        credentials: 'same-origin',
        headers: naglowki,
        body,
      });
      return JSON.stringify({ status: res.status, tresc: await res.text() });
    })()`;
}

/**
 * Skrypt wykonywany W PRZEGLĄDARCE: szuka tokenu CSRF we WSZYSTKICH trzech postaciach, w jakich
 * podaje go Laravel (`<meta name="csrf-token">`, ukryte pole `_token`, ciasteczko `XSRF-TOKEN`),
 * a przy okazji zbiera opis strony na wypadek, gdyby żadnej nie było.
 */
export function skryptTokenu(): string {
  return `JSON.stringify({
    csrf: document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
       || document.querySelector('input[name="_token"]')?.value || '',
    xsrf: (() => {
      const m = document.cookie.match(/(?:^|;\\s*)XSRF-TOKEN=([^;]*)/);
      try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m ? m[1] : ''; }
    })(),
    tytul: document.title || '',
    adres: location.href,
    ciasteczka: document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).join(', '),
    meta: [...document.querySelectorAll('meta[name]')].map((m) => m.getAttribute('name')).join(', '),
    tekst: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
  })`;
}

/**
 * Czeka, aż na stronie pojawi się token CSRF — w KTÓREJKOLWIEK z trzech postaci, w jakich Laravel
 * go podaje: `<meta name="csrf-token">`, ukryte pole `_token`, ciasteczko `XSRF-TOKEN`.
 *
 * Czekamy, bo pierwsze wejście trafia zwykle na przejściówkę Cloudflare: zdarzenie "strona
 * wczytana" pada wtedy dla PRZEJŚCIÓWKI, a nie dla właściwej strony, i tokenu jeszcze nie ma.
 * Zdalna przeglądarka przechodzi to sama, ale potrzebuje na to kilku sekund.
 *
 * Gdy po tym czasie tokenu dalej nie ma, NIE zgłaszamy suchego "nie ma tokenu" — do komunikatu
 * trafia tytuł strony, jej adres, nazwy ciasteczek i początek widocznego tekstu. Bez tego nie da
 * się odróżnić "nie zdążyła przejść Cloudflare" od "token jest gdzie indziej".
 */
async function poczekajNaToken(cdp: CdpSession, sessionId: string): Promise<Token> {
  const wyrazenie = skryptTokenu();
  const koniec = Date.now() + 45_000;
  let ostatni: Record<string, string> = {};
  for (;;) {
    const wynik = (await cdp.send(
      "Runtime.evaluate",
      { expression: wyrazenie, returnByValue: true },
      sessionId,
      30_000,
    )) as { result?: { value?: string } };
    ostatni = JSON.parse(wynik.result?.value ?? "{}") as Record<string, string>;
    if (ostatni.csrf || ostatni.xsrf) return { csrf: ostatni.csrf ?? "", xsrf: ostatni.xsrf ?? "" };
    if (Date.now() > koniec) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error(
    `Na stronie Baltic Hub nie pojawił się token CSRF w ciągu 45 s. ` +
      `Tytuł: „${ostatni.tytul ?? ""}”. Adres: ${ostatni.adres ?? "?"}. ` +
      `Ciasteczka: ${ostatni.ciasteczka || "(brak)"}. Znaczniki meta: ${ostatni.meta || "(brak)"}. ` +
      `Tekst strony: ${ostatni.tekst ?? ""}`,
  );
}

/**
 * Otwiera stronę Baltic Hub i Z JEJ WNĘTRZA wysyła zapytanie o kontenery. Kluczowe jest to "z
 * wnętrza": przeglądarka dokłada wtedy ciasteczko sesji sama, a token CSRF czytamy ze strony —
 * dokładnie tak, jak robi to dyspozytor klikając "Sprawdź".
 */
export async function fetchViaBrowser(
  pageUrl: string,
  postUrl: string,
  containers: string[],
): Promise<string> {
  // Powód niepowodzenia niesie już sam klient (kod odpowiedzi i treść od serwera), więc nie ma
  // tu osobnej diagnozy — dwa mechanizmy mówiące o tym samym rozjechałyby się przy pierwszej
  // poprawce.
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

    const token = await poczekajNaToken(cdp, sessionId);

    const wyrazenie = skryptZapytania(token, postUrl, containers);

    const wynik = (await cdp.send(
      "Runtime.evaluate",
      { expression: wyrazenie, awaitPromise: true, returnByValue: true },
      sessionId,
      90_000,
    )) as { result?: { value?: string }; exceptionDetails?: { text?: string } };

    if (wynik.exceptionDetails) {
      throw new Error(`Strona zgłosiła błąd: ${wynik.exceptionDetails.text ?? "nieznany"}`);
    }
    const odpowiedz = JSON.parse(wynik.result?.value ?? "{}") as { status?: number; tresc?: string };
    if (odpowiedz.status !== 200) {
      throw new Error(`Baltic Hub odpowiedział HTTP ${odpowiedz.status} na zapytanie o kontenery.`);
    }

    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    return odpowiedz.tresc ?? "";
  } finally {
    cdp.close();
  }
}
