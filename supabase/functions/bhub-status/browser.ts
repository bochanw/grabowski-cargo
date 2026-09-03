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
// Puppeteer i Playwright ciągną za sobą pół Node'a. Tu potrzebujemy dosłownie czterech poleceń
// protokołu, a Deno ma WebSocket wbudowany — sprawdzone funkcją próbną, że Edge Function otwiera
// połączenie WSS na zewnątrz (echo.websocket.org: połączono w 240 ms).
//
// ========================= SKĄD OSZCZĘDNOŚĆ =========================
// Rozliczenie idzie za PRZESŁANE DANE (8 USD/GB), więc blokujemy obrazki, czcionki i style —
// do odczytania statusu są niepotrzebne, a to one stanowią większość z ~285 kB strony.
// Jedna sesja przeglądarki obsługuje CAŁY przebieg (wszystkie paczki), nie każdą z osobna.

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
  #ws: WebSocket;
  #nextId = 1;
  #oczekujace = new Map<number, { ok: (r: Record<string, unknown>) => void; blad: (e: Error) => void }>();
  #zdarzenia = new Map<string, () => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (e) => this.#odbierz(String(e.data));
    ws.onclose = () => this.#przerwij(new Error("Zdalna przeglądarka zamknęła połączenie."));
    ws.onerror = () => this.#przerwij(new Error("Błąd połączenia ze zdalną przeglądarką."));
  }

  static connect(endpoint: string, timeoutMs: number): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(endpoint);
      } catch (e) {
        return reject(new Error(`Nie udało się otworzyć połączenia z przeglądarką: ${e}`));
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* nie szkodzi */ }
        reject(new Error("Zdalna przeglądarka nie odpowiedziała w wyznaczonym czasie."));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        // Bez wskazywania winnego: `onerror` nie wie, czy to hasło, port, czy sam serwer.
        // Powód dopisuje diagnozujPolaczenie() po tym, jak zapyta serwer wprost.
        reject(new Error("Nie udało się połączyć ze zdalną przeglądarką."));
      };
    });
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
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
 * Adres z danymi logowania. Sprawdzone doświadczalnie, nie założone: Deno wysyła z takiego adresu
 * nagłówek `Authorization: Basic`, a `%XX` odkodowuje przed jego zbudowaniem — czyli
 * `encodeURIComponent` jest tu potrzebne (bez niego hasło ze znakiem `/` w ogóle nie zbuduje URL-a)
 * i niczego nie psuje.
 */
function endpoint(): string {
  const { user, pass } = daneLogowania();
  return `wss://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${CDP_HOST}`;
}

/**
 * DLACZEGO połączenie nie doszło do skutku.
 *
 * Wbudowany `WebSocket` jest tu ślepy: `onerror` nie niesie ani kodu odpowiedzi, ani treści, więc
 * "nie udało się" znaczy jednocześnie "złe hasło", "port nie wychodzi" i "serwer nie odpowiada".
 * Zgadywanie między nimi kosztowało już rundę, więc przy niepowodzeniu otwieramy zwykłe połączenie
 * TLS, wysyłamy to samo uzgodnienie ręcznie i CZYTAMY odpowiedź serwera. Robimy to wyłącznie po
 * błędzie — normalna ścieżka zostaje prosta.
 */
async function diagnozujPolaczenie(): Promise<string> {
  const { user, pass } = daneLogowania();
  const [hostname, port] = [CDP_HOST.split(":")[0], Number(CDP_HOST.split(":")[1] ?? 443)];

  // Limit czasu na SAMO otwarcie połączenia. Bez niego `connectTls` do zablokowanego portu wisi
  // bez końca (sprawdzone — trzeba było ubić proces), a zawieszona diagnoza jest gorsza niż jej
  // brak: funkcja brzegowa ginie z upływem czasu życia i przy zleceniach nie zostaje ŻADEN ślad.
  let conn: Deno.TlsConn;
  try {
    const otwarte = await Promise.race([
      Deno.connectTls({ hostname, port }),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    if (!otwarte) {
      return (
        `połączenie z ${hostname}:${port} nie doszło do skutku w 10 s (bez odmowy, po prostu ` +
        `cisza) — tak zachowuje się zablokowany port, a nie złe dane logowania.`
      );
    }
    conn = otwarte;
  } catch (e) {
    return (
      `nie udało się w ogóle otworzyć połączenia z ${hostname}:${port} ` +
      `(${e instanceof Error ? e.message : String(e)}) — to zwykle znaczy, że ruch na ten port ` +
      `nie wychodzi z Supabase, a nie że dane logowania są złe.`
    );
  }

  try {
    const klucz = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const zadanie =
      `GET / HTTP/1.1\r\n` +
      `Host: ${CDP_HOST}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${klucz}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Authorization: Basic ${btoa(`${user}:${pass}`)}\r\n` +
      `\r\n`;
    await conn.write(new TextEncoder().encode(zadanie));

    const bufor = new Uint8Array(2048);
    const odczyt = await Promise.race([
      conn.read(bufor),
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    if (!odczyt) return "serwer przyjął połączenie, ale nie odpowiedział na uzgodnienie.";

    const odpowiedz = new TextDecoder().decode(bufor.subarray(0, odczyt));
    const [naglowek, tresc] = odpowiedz.split("\r\n\r\n");
    const pierwsza = naglowek.split("\r\n")[0] ?? "";
    if (/\b101\b/.test(pierwsza)) {
      return `serwer PRZYJĄŁ uzgodnienie (${pierwsza}) — dane logowania są dobre, problem leży dalej.`;
    }
    const ogon = (tresc ?? "").trim().slice(0, 200);
    return `serwer odpowiedział „${pierwsza}"${ogon ? ` — ${ogon}` : ""}.`;
  } catch (e) {
    return `uzgodnienie przerwane: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try { conn.close(); } catch { /* nie szkodzi */ }
  }
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
  let cdp: CdpSession;
  try {
    cdp = await CdpSession.connect(endpoint(), 30_000);
  } catch (e) {
    // Zamiast domysłu dopisujemy do komunikatu to, co serwer FAKTYCZNIE odpowiedział.
    const powod = await diagnozujPolaczenie().catch(
      (d) => `nie udało się ustalić powodu (${d instanceof Error ? d.message : String(d)})`,
    );
    throw new Error(`${e instanceof Error ? e.message : String(e)} Sprawdzenie wprost: ${powod}`);
  }

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

    // Zapytanie leci z wnętrza strony — stąd ciasteczka i token "same się" dokładają.
    const wyrazenie = `(async () => {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      if (!token) return JSON.stringify({ blad: 'Na stronie nie ma tokenu csrf-token.' });
      const body = ${JSON.stringify("lang=pl")} + ${JSON.stringify(containers)}
        .map((c) => '&id%5B%5D=' + encodeURIComponent(c)).join('');
      const res = await fetch(${JSON.stringify(postUrl)}, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-TOKEN': token,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
      });
      return JSON.stringify({ status: res.status, tresc: await res.text() });
    })()`;

    const wynik = (await cdp.send(
      "Runtime.evaluate",
      { expression: wyrazenie, awaitPromise: true, returnByValue: true },
      sessionId,
      90_000,
    )) as { result?: { value?: string }; exceptionDetails?: { text?: string } };

    if (wynik.exceptionDetails) {
      throw new Error(`Strona zgłosiła błąd: ${wynik.exceptionDetails.text ?? "nieznany"}`);
    }
    const odpowiedz = JSON.parse(wynik.result?.value ?? "{}") as {
      blad?: string;
      status?: number;
      tresc?: string;
    };
    if (odpowiedz.blad) throw new Error(odpowiedz.blad);
    if (odpowiedz.status !== 200) {
      throw new Error(`Baltic Hub odpowiedział HTTP ${odpowiedz.status} na zapytanie o kontenery.`);
    }

    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    return odpowiedz.tresc ?? "";
  } finally {
    cdp.close();
  }
}
