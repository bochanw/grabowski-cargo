// Test klienta IMAP przeciwko atrapie serwera mówiącej prawdziwym protokołem.
//
// Sprawdza to, co w ręcznie pisanym kliencie IMAP psuje się najczęściej i NAJCICHEJ:
//  - literał `{N}` z CRLF-ami w środku (surowy mail z załącznikiem) — czytanie „po liniach"
//    rozjeżdża tu strumień i kolejne komendy dostają cudzą odpowiedź,
//  - `UID SEARCH UID X:*`, które zwraca najwyższy UID nawet gdy jest MNIEJSZY niż X (czyli gdy
//    nie ma nic nowego) — bez filtra po stronie klienta poller w kółko pobierałby ostatni mail,
//  - błąd logowania: komunikat serwera musi dojść do wywołującego, ale hasło NIE może wyciec.
//
// Uruchomienie: deno test --allow-net supabase/functions/gmail-poll/imap.test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { ImapClient, ImapError } from "./imap.ts";

const CRLF = "\r\n";

// Surowy mail z załącznikiem — CRLF-y w środku literału są tu istotą testu.
const RAW_MESSAGE = [
  "From: Spedycja <biuro@example.com>",
  "Subject: Zlecenie ZD/1797/6/2026",
  "Message-ID: <abc@example.com>",
  "",
  "Tresc pierwsza linia",
  "Tresc druga linia",
  "",
].join(CRLF);

interface Scenario {
  failLogin?: boolean;
  searchReply?: string;
}

/** Atrapa serwera IMAP na losowym porcie. Zwraca port i funkcję zamykającą. */
async function startFakeServer(scenario: Scenario = {}) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const seenCommands: string[] = [];

  (async () => {
    for await (const conn of listener) {
      (async () => {
        const encoder = new TextEncoder();
        const write = (text: string) => conn.write(encoder.encode(text));
        await write(`* OK Gimap ready${CRLF}`);

        const buf = new Uint8Array(4096);
        let pending = "";
        for (;;) {
          const n = await conn.read(buf).catch(() => null);
          if (n === null) break;
          pending += new TextDecoder().decode(buf.subarray(0, n));
          let index: number;
          while ((index = pending.indexOf(CRLF)) !== -1) {
            const line = pending.slice(0, index);
            pending = pending.slice(index + 2);
            const [tag, command] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
            seenCommands.push(command);

            if (/^LOGIN/i.test(command)) {
              if (scenario.failLogin) {
                await write(`${tag} NO [ALERT] Application-specific password required${CRLF}`);
              } else {
                await write(`${tag} OK LOGIN completed${CRLF}`);
              }
            } else if (/^(EXAMINE|SELECT)/i.test(command)) {
              await write(`* 231 EXISTS${CRLF}`);
              await write(`* OK [UIDVALIDITY 42] UIDs valid${CRLF}`);
              await write(`* OK [UIDNEXT 1010] Predicted next UID${CRLF}`);
              // Prawdziwy serwer odpowiada na EXAMINE właśnie READ-ONLY.
              await write(`${tag} OK [READ-ONLY] EXAMINE completed${CRLF}`);
            } else if (/^UID SEARCH/i.test(command)) {
              await write(scenario.searchReply ?? `* SEARCH 1005 1006 1007${CRLF}`);
              await write(`${tag} OK SEARCH completed${CRLF}`);
            } else if (/^UID FETCH/i.test(command)) {
              // Dokładnie ten kształt, który wysyła Gmail: literał z rozmiarem w bajtach,
              // treść, a po niej domykający nawias w tej samej "linii".
              const bytes = new TextEncoder().encode(RAW_MESSAGE).length;
              await write(`* 1 FETCH (UID 1005 BODY[] {${bytes}}${CRLF}`);
              await write(RAW_MESSAGE);
              await write(`)${CRLF}`);
              await write(`${tag} OK FETCH completed${CRLF}`);
            } else if (/^LOGOUT/i.test(command)) {
              await write(`* BYE${CRLF}`);
              await write(`${tag} OK LOGOUT completed${CRLF}`);
              conn.close();
              return;
            } else {
              await write(`${tag} BAD unknown${CRLF}`);
            }
          }
        }
      })().catch(() => {});
    }
  })().catch(() => {});

  return { port, seenCommands, close: () => listener.close() };
}

Deno.test("czyta mail z literału zawierającego CRLF, bez gubienia treści", async () => {
  const server = await startFakeServer();
  const client = new ImapClient({ timeoutMs: 5_000 });
  try {
    await client.adopt(await Deno.connect({ hostname: "127.0.0.1", port: server.port }));
    await client.login("konto@gmail.com", "abcd efgh ijkl mnop");

    const mailbox = await client.selectInbox();
    assertEquals(mailbox.uidValidity, 42);
    assertEquals(mailbox.uidNext, 1010);

    const raw = await client.fetchRaw(1005);
    assert(raw, "fetchRaw zwrócił null");
    // Cała treść, łącznie z obiema liniami po pustej — czyli literał został policzony w bajtach,
    // a nie ucięty na pierwszym CRLF.
    assertStringIncludes(raw, "Message-ID: <abc@example.com>");
    assertStringIncludes(raw, "Tresc pierwsza linia");
    assertStringIncludes(raw, "Tresc druga linia");

    await client.logout();
  } finally {
    client.close();
    server.close();
  }
});

Deno.test("SELECT po FETCH dostaje własną odpowiedź (strumień nie rozjechał się na literale)", async () => {
  const server = await startFakeServer();
  const client = new ImapClient({ timeoutMs: 5_000 });
  try {
    await client.adopt(await Deno.connect({ hostname: "127.0.0.1", port: server.port }));
    await client.login("konto@gmail.com", "haslo");
    await client.selectInbox();
    await client.fetchRaw(1005);
    // Gdyby domykający `)` po literale nie został skonsumowany, TA komenda dostałaby jego resztkę.
    const mailbox = await client.selectInbox();
    assertEquals(mailbox.uidNext, 1010);
  } finally {
    client.close();
    server.close();
  }
});

Deno.test("UID SEARCH X:* nie zwraca UID-ów starszych niż ostatnio przetworzony", async () => {
  // Gmail na zakres `1006:*` odpowiada najwyższym istniejącym UID-em (1005), mimo że jest
  // MNIEJSZY — to normalne zachowanie IMAP-a, nie błąd. Klient musi je odfiltrować.
  const server = await startFakeServer({ searchReply: `* SEARCH 1005${CRLF}` });
  const client = new ImapClient({ timeoutMs: 5_000 });
  try {
    await client.adopt(await Deno.connect({ hostname: "127.0.0.1", port: server.port }));
    await client.login("konto@gmail.com", "haslo");
    await client.selectInbox();
    assertEquals(await client.searchAfter(1005), [], "stary UID nie może wrócić jako nowy");
    assertEquals(await client.searchAfter(1000), [1005]);
  } finally {
    client.close();
    server.close();
  }
});

Deno.test("błąd logowania niesie komunikat serwera, ale nie hasło", async () => {
  const server = await startFakeServer({ failLogin: true });
  const client = new ImapClient({ timeoutMs: 5_000 });
  try {
    await client.adopt(await Deno.connect({ hostname: "127.0.0.1", port: server.port }));
    const error = await client.login("konto@gmail.com", "tajne-haslo-aplikacji").then(
      () => null,
      (e) => e as ImapError,
    );
    assert(error instanceof ImapError, "logowanie powinno rzucić ImapError");
    assertStringIncludes(error.message, "Application-specific password required");
    assert(!error.message.includes("tajne-haslo-aplikacji"), "hasło wyciekło do komunikatu błędu");
    assert(!error.message.includes("konto@gmail.com"), "adres konta wyciekł do komunikatu błędu");
  } finally {
    client.close();
    server.close();
  }
});

Deno.test("wiele UID-ów pod rząd — każdy FETCH dostaje pełną treść", async () => {
  const server = await startFakeServer();
  const client = new ImapClient({ timeoutMs: 5_000 });
  try {
    await client.adopt(await Deno.connect({ hostname: "127.0.0.1", port: server.port }));
    await client.login("konto@gmail.com", "haslo");
    await client.selectInbox();
    for (const uid of await client.searchAfter(1000)) {
      const raw = await client.fetchRaw(uid);
      assert(raw, `brak treści dla UID ${uid}`);
      assertStringIncludes(raw, "Tresc druga linia");
    }
  } finally {
    client.close();
    server.close();
  }
});

/**
 * STRAŻ na wprost postawiony warunek właściciela: "nie dodaje flag, nie oznacza wiadomości jako
 * odczytane — to ważne".
 *
 * Test patrzy na to, co klient FAKTYCZNIE WYSYŁA do serwera, a nie na to, co deklaruje kod.
 * Dwie rzeczy naraz: skrzynka otwierana tylko do odczytu (EXAMINE, nie SELECT) i treść pobierana
 * przez BODY.PEEK[] — zwykłe BODY[] ustawiłoby \Seen, czyli oznaczyłoby maila jako przeczytany.
 */
Deno.test("odczyt skrzynki NICZEGO w niej nie zmienia (bez flag, bez oznaczania jako przeczytane)", async () => {
  const server = await startFakeServer();
  const client = new ImapClient({ timeoutMs: 5_000 });
  try {
    await client.adopt(await Deno.connect({ hostname: "127.0.0.1", port: server.port }));
    await client.login("konto@example.com", "haslo");
    await client.selectInbox();
    for (const uid of await client.searchAfter(1004)) await client.fetchRaw(uid);
    await client.logout();

    const wyslane = server.seenCommands.join(" | ");

    assertEquals(
      server.seenCommands.some((c) => /^EXAMINE/i.test(c)),
      true,
      `skrzynka musi byc otwarta TYLKO DO ODCZYTU (EXAMINE); wyslano: ${wyslane}`,
    );
    assertEquals(
      server.seenCommands.some((c) => /^SELECT/i.test(c)),
      false,
      `SELECT otwiera skrzynke do zapisu - nie wolno go uzyc; wyslano: ${wyslane}`,
    );

    // Polecenia, ktore w IMAP-ie zmieniaja stan skrzynki. Zadne nie ma prawa pa/sc.
    for (const zakazane of [/\bSTORE\b/i, /\bCOPY\b/i, /\bMOVE\b/i, /\bEXPUNGE\b/i, /\bAPPEND\b/i]) {
      assertEquals(
        server.seenCommands.some((c) => zakazane.test(c)),
        false,
        `polecenie ${zakazane} zmienia skrzynke; wyslano: ${wyslane}`,
      );
    }

    // Tresc TYLKO przez PEEK: zwykle BODY[] ustawia \Seen po stronie serwera.
    const pobrania = server.seenCommands.filter((c) => /^UID FETCH/i.test(c));
    assert(pobrania.length > 0, "test nic nie pobral, wiec niczego nie sprawdza");
    for (const p of pobrania) {
      assertEquals(/BODY\.PEEK\[/i.test(p), true, `pobranie bez PEEK oznaczyloby maila: ${p}`);
    }
  } finally {
    client.close();
    server.close();
  }
});
