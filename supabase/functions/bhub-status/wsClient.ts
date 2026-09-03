// Własne połączenie WebSocket na surowym TLS.
//
// ======================== DLACZEGO NIE WBUDOWANY WebSocket ========================
// Bright Data wymaga nagłówka `Authorization`, a wbudowany `WebSocket` nie pozwala podać własnych
// nagłówków — jedyną drogą jest wpisanie danych logowania w adresie (`wss://user:pass@host`).
// Zmierzone na produkcji, nie założone: to samo uzgodnienie wysłane RĘCZNIE, z nagłówkiem
// `Authorization: Basic`, dostaje `HTTP/1.1 101 Switching Protocols`, a wbudowany `WebSocket` pod
// tym samym adresem i z tymi samymi danymi kończy się błędem. Deno na zwykłym komputerze buduje
// z takiego adresu nagłówek Basic (sprawdzone osobnym testem), ale runtime Supabase najwyraźniej
// nie — i nie ma tam sposobu, żeby go dołożyć.
//
// Stąd ten plik: uzgodnienie i ramki robimy sami. Jest tego ~150 linii, za to nagłówki są nasze,
// a błąd w końcu ma treść — wbudowany `onerror` nie niesie ani kodu, ani powodu.
//
// Zakres świadomie wąski: klient (ramki wychodzące ZAWSZE maskowane, tego wymaga standard),
// wiadomości tekstowe, sklejanie wiadomości pociętych na części, odpowiadanie na ping. Tyle
// wymaga protokół CDP i nic ponadto.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const OPCODE = { ciag_dalszy: 0x0, tekst: 0x1, dane: 0x2, zamknij: 0x8, ping: 0x9, pong: 0xa } as const;

function polacz(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

interface Ramka {
  fin: boolean;
  opcode: number;
  tresc: Uint8Array;
  dlugoscCalkowita: number;
}

/**
 * Wyjmuje JEDNĄ ramkę z bufora. `null` = ramka jeszcze nie doszła w całości; wtedy czekamy na
 * kolejne bajty, nie zgadujemy. Ramki od serwera nie są maskowane (tak mówi standard), ale
 * obsługujemy maskę na wszelki wypadek — koszt to cztery linijki.
 */
function wyjmijRamke(bufor: Uint8Array): Ramka | null {
  if (bufor.length < 2) return null;
  const fin = (bufor[0] & 0x80) !== 0;
  const opcode = bufor[0] & 0x0f;
  const zamaskowana = (bufor[1] & 0x80) !== 0;
  let dlugosc = bufor[1] & 0x7f;
  let pozycja = 2;

  if (dlugosc === 126) {
    if (bufor.length < pozycja + 2) return null;
    dlugosc = new DataView(bufor.buffer, bufor.byteOffset + pozycja, 2).getUint16(0);
    pozycja += 2;
  } else if (dlugosc === 127) {
    if (bufor.length < pozycja + 8) return null;
    const duza = new DataView(bufor.buffer, bufor.byteOffset + pozycja, 8).getBigUint64(0);
    // Odpowiedź `/multi` to setki kilobajtów, ale nigdy nie gigabajty — ramka większa niż
    // pamięć funkcji brzegowej to objaw błędu, nie danych.
    if (duza > 64_000_000n) throw new Error("Zdalna przeglądarka przysłała nieprawdopodobnie dużą ramkę.");
    dlugosc = Number(duza);
    pozycja += 8;
  }

  let maska: Uint8Array | null = null;
  if (zamaskowana) {
    if (bufor.length < pozycja + 4) return null;
    maska = bufor.subarray(pozycja, pozycja + 4);
    pozycja += 4;
  }

  if (bufor.length < pozycja + dlugosc) return null;

  let tresc = bufor.slice(pozycja, pozycja + dlugosc);
  if (maska) {
    for (let i = 0; i < tresc.length; i++) tresc[i] ^= maska[i % 4];
  }
  return { fin, opcode, tresc, dlugoscCalkowita: pozycja + dlugosc };
}

export interface PolaczenieOpcje {
  hostname: string;
  port: number;
  path?: string;
  headers?: Record<string, string>;
  /** Limit na otwarcie połączenia I uzgodnienie — bez niego zablokowany port wisi bez końca. */
  timeoutMs?: number;
}

export class RawWebSocket {
  #conn: Deno.TlsConn;
  #bufor: Uint8Array = new Uint8Array(0);
  #czesci: Uint8Array = new Uint8Array(0);
  #opcodeCiagu = 0;
  #zamkniete = false;
  /** Zapisy szeregujemy, żeby odpowiedź na ping nie wcięła się w środek wysyłanego polecenia. */
  #kolejkaZapisu: Promise<void> = Promise.resolve();

  onMessage: (tekst: string) => void = () => {};
  onClose: (powod: string) => void = () => {};

  private constructor(conn: Deno.TlsConn, ogon: Uint8Array) {
    this.#conn = conn;
    this.#bufor = ogon;
    void this.#petlaOdczytu();
  }

  static async connect(opcje: PolaczenieOpcje): Promise<RawWebSocket> {
    const { hostname, port, path = "/", headers = {}, timeoutMs = 30_000 } = opcje;

    const otwarte = await Promise.race([
      Deno.connectTls({ hostname, port }),
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
    if (!otwarte) {
      throw new Error(
        `Połączenie z ${hostname}:${port} nie doszło do skutku w ${Math.round(timeoutMs / 1000)} s ` +
          `(bez odmowy, po prostu cisza).`,
      );
    }
    const conn = otwarte;

    try {
      const klucz = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const zadanie =
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${hostname}:${port}`,
          `Upgrade: websocket`,
          `Connection: Upgrade`,
          `Sec-WebSocket-Key: ${klucz}`,
          `Sec-WebSocket-Version: 13`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ].join("\r\n") + "\r\n\r\n";
      await zapiszWszystko(conn, encoder.encode(zadanie));

      // Czytamy do końca nagłówków. Serwer MOŻE dokleić pierwsze ramki w tym samym pakiecie,
      // więc reszta bajtów musi trafić do bufora ramek, a nie zostać wyrzucona.
      let odebrane: Uint8Array = new Uint8Array(0);
      const kawalek = new Uint8Array(8192);
      const koniecCzasu = Date.now() + timeoutMs;
      let granica = -1;
      while (granica < 0) {
        if (Date.now() > koniecCzasu) throw new Error("Serwer nie dokończył uzgodnienia w wyznaczonym czasie.");
        const n = await Promise.race([
          conn.read(kawalek),
          new Promise<null>((r) => setTimeout(() => r(null), Math.max(1000, koniecCzasu - Date.now()))),
        ]);
        if (!n) throw new Error("Serwer przyjął połączenie, ale nie odpowiedział na uzgodnienie.");
        odebrane = polacz(odebrane, kawalek.subarray(0, n));
        granica = szukajPodwojnegoEnteru(odebrane);
      }

      const naglowki = decoder.decode(odebrane.subarray(0, granica));
      const pierwsza = naglowki.split("\r\n")[0] ?? "";
      if (!/\b101\b/.test(pierwsza)) {
        // Cała wartość tej klasy: powód zamiast "nie udało się".
        const tresc = decoder.decode(odebrane.subarray(granica + 4)).trim().slice(0, 300);
        throw new Error(`Serwer odrzucił uzgodnienie: „${pierwsza}”${tresc ? ` — ${tresc}` : ""}`);
      }

      return new RawWebSocket(conn, odebrane.slice(granica + 4));
    } catch (e) {
      try { conn.close(); } catch { /* nie szkodzi */ }
      throw e;
    }
  }

  send(tekst: string): Promise<void> {
    return this.#wyslij(OPCODE.tekst, encoder.encode(tekst));
  }

  close(): void {
    if (this.#zamkniete) return;
    this.#zamkniete = true;
    // Uprzejme pożegnanie, ale bez czekania: i tak zaraz zamykamy gniazdo.
    this.#wyslij(OPCODE.zamknij, new Uint8Array(0)).catch(() => undefined);
    try { this.#conn.close(); } catch { /* nie szkodzi */ }
  }

  #wyslij(opcode: number, tresc: Uint8Array): Promise<void> {
    const zadanie = this.#kolejkaZapisu.then(async () => {
      if (this.#zamkniete && opcode !== OPCODE.zamknij) return;
      const maska = crypto.getRandomValues(new Uint8Array(4));
      const dlugosc = tresc.length;

      let naglowek: Uint8Array;
      if (dlugosc < 126) {
        naglowek = new Uint8Array(2);
        naglowek[1] = 0x80 | dlugosc;
      } else if (dlugosc < 65_536) {
        naglowek = new Uint8Array(4);
        naglowek[1] = 0x80 | 126;
        new DataView(naglowek.buffer).setUint16(2, dlugosc);
      } else {
        naglowek = new Uint8Array(10);
        naglowek[1] = 0x80 | 127;
        new DataView(naglowek.buffer).setBigUint64(2, BigInt(dlugosc));
      }
      naglowek[0] = 0x80 | opcode;

      const zamaskowana = new Uint8Array(dlugosc);
      for (let i = 0; i < dlugosc; i++) zamaskowana[i] = tresc[i] ^ maska[i % 4];

      await zapiszWszystko(this.#conn, polacz(polacz(naglowek, maska), zamaskowana));
    });
    // Błąd jednego zapisu nie może zablokować kolejki na zawsze.
    this.#kolejkaZapisu = zadanie.catch(() => undefined);
    return zadanie;
  }

  async #petlaOdczytu(): Promise<void> {
    const kawalek = new Uint8Array(65_536);
    try {
      // Bajty doklejone do uzgodnienia mogą już zawierać całą ramkę.
      this.#przetworzBufor();
      while (!this.#zamkniete) {
        const n = await this.#conn.read(kawalek);
        if (n === null) {
          this.#zakoncz("Zdalna przeglądarka zamknęła połączenie.");
          return;
        }
        this.#bufor = polacz(this.#bufor, kawalek.subarray(0, n));
        this.#przetworzBufor();
      }
    } catch (e) {
      this.#zakoncz(`Połączenie ze zdalną przeglądarką przerwane: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  #przetworzBufor(): void {
    for (;;) {
      let ramka: Ramka | null;
      try {
        ramka = wyjmijRamke(this.#bufor);
      } catch (e) {
        this.#zakoncz(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!ramka) return;
      this.#bufor = this.#bufor.slice(ramka.dlugoscCalkowita);

      if (ramka.opcode === OPCODE.ping) {
        this.#wyslij(OPCODE.pong, ramka.tresc).catch(() => undefined);
        continue;
      }
      if (ramka.opcode === OPCODE.pong) continue;
      if (ramka.opcode === OPCODE.zamknij) {
        this.#zakoncz("Zdalna przeglądarka zamknęła połączenie.");
        return;
      }

      // Wiadomość bywa pocięta na części: pierwsza niesie opcode, kolejne mają opcode 0,
      // a dopiero ostatnia ma ustawione FIN. Odpowiedź z całą stroną potrafi tak przyjść.
      if (ramka.opcode !== OPCODE.ciag_dalszy) {
        this.#opcodeCiagu = ramka.opcode;
        this.#czesci = ramka.tresc;
      } else {
        this.#czesci = polacz(this.#czesci, ramka.tresc);
      }

      if (ramka.fin) {
        const calosc = this.#czesci;
        this.#czesci = new Uint8Array(0);
        if (this.#opcodeCiagu === OPCODE.tekst) this.onMessage(decoder.decode(calosc));
      }
    }
  }

  #zakoncz(powod: string): void {
    if (this.#zamkniete) return;
    this.#zamkniete = true;
    try { this.#conn.close(); } catch { /* nie szkodzi */ }
    this.onClose(powod);
  }
}

/** `conn.write` potrafi zapisać TYLKO CZĘŚĆ danych — bez tej pętli duże polecenia urywałyby się. */
async function zapiszWszystko(conn: Deno.TlsConn, dane: Uint8Array): Promise<void> {
  let zapisane = 0;
  while (zapisane < dane.length) {
    zapisane += await conn.write(dane.subarray(zapisane));
  }
}

function szukajPodwojnegoEnteru(bufor: Uint8Array): number {
  for (let i = 0; i + 3 < bufor.length; i++) {
    if (bufor[i] === 13 && bufor[i + 1] === 10 && bufor[i + 2] === 13 && bufor[i + 3] === 10) return i;
  }
  return -1;
}
