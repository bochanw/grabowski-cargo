// Testy prefiltru — to on decyduje, ile appka wyda na odczyt, i on realizuje wymóg właściciela
// „nawet jak klient dośle informację w treści/dodatkowym, program to zobaczy".
//
// Uruchomienie: deno test supabase/functions/mail-poll/relevance.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { assessRelevance } from "./relevance.ts";

const LOADS = new Map([
  ["ZD179762026", { id: "load-1", order_number: "ZD/1797/6/2026" }],
  ["TIIU218", { id: "load-2", order_number: "TIIU218" }],
]);

function mail(overrides: Partial<Parameters<typeof assessRelevance>[0]> = {}) {
  return { subject: "", bodyText: "", threadRefs: [], attachments: [], ...overrides };
}
const PDF = [{ filename: "zlecenie.pdf", bytes: new Uint8Array([1]) }];

Deno.test("numer zlecenia w temacie wiąże maila z istniejącym zleceniem", () => {
  const result = assessRelevance(mail({ subject: "Re: ZD/1797/6/2026 — zmiana terminu" }), LOADS, new Map());
  assertEquals(result.relevant, true);
  assertEquals(result.matchedLoadId, "load-1");
});

Deno.test("numer zapisany inaczej niż w bazie nadal trafia", () => {
  // Spedytor pisze "ZD 1797-6 2026", w bazie stoi "ZD/1797/6/2026" — obie strony są
  // normalizowane do samych znaków alfanumerycznych, więc to jest to samo zlecenie.
  for (const subject of ["ZD 1797-6 2026", "zd/1797/6/2026", "dot. zd1797 6 2026 pilne"]) {
    assertEquals(assessRelevance(mail({ subject }), LOADS, new Map()).matchedLoadId, "load-1", subject);
  }
});

Deno.test("numer w TREŚCI, nie w temacie, też wystarcza", () => {
  const result = assessRelevance(
    mail({ subject: "Zmiana", bodyText: "Dzień dobry, do zlecenia ZD/1797/6/2026 dosyłam wagę." }),
    LOADS,
    new Map(),
  );
  assertEquals(result.matchedLoadId, "load-1");
});

Deno.test("odpowiedź w wątku bez numeru i bez załącznika — wymóg właściciela", () => {
  // "ok, potwierdzam" w odpowiedzi na maila, którego już powiązaliśmy ze zleceniem.
  const threads = new Map([["conv-abc", "load-2"]]);
  const result = assessRelevance(
    mail({ subject: "Re: transport", bodyText: "Ok, potwierdzam piątek.", threadRefs: ["conv-abc"] }),
    LOADS,
    threads,
  );
  assertEquals(result.relevant, true);
  assertEquals(result.matchedLoadId, "load-2");
});

Deno.test("mail z PDF-em od nieznanego nadawcy to kandydat na NOWE zlecenie", () => {
  const result = assessRelevance(mail({ subject: "Zlecenie", attachments: PDF }), LOADS, new Map());
  assertEquals(result.relevant, true);
  assertEquals(result.matchedLoadId, null);
});

Deno.test("zwykły mail bez PDF-a, numeru i wątku NIE idzie do modelu", () => {
  // To jest cały hamulec kosztów: newsletter, spam, korespondencja niezwiązana z transportem.
  const result = assessRelevance(
    mail({ subject: "Newsletter branżowy", bodyText: "Zapraszamy na targi logistyczne." }),
    LOADS,
    new Map(),
  );
  assertEquals(result.relevant, false);
  assertEquals(result.matchedLoadId, null);
});

Deno.test("krótki numer zlecenia nie łapie przypadkowych liczb", () => {
  // Zlecenie o numerze "12/26" znormalizuje się do "1226" — poniżej progu, więc NIE może
  // dopasować się do "faktura 1226" ani do daty w stopce.
  const shortLoads = new Map([["1226", { id: "load-3", order_number: "12/26" }]]);
  const result = assessRelevance(
    mail({ subject: "Faktura 1226 do zapłaty", bodyText: "" }),
    shortLoads,
    new Map(),
  );
  assertEquals(result.relevant, false);
});

Deno.test("mail z PDF-em ORAZ numerem znanego zlecenia wiąże się ze zleceniem, nie tworzy nowego", () => {
  // Dosłany list przewozowy do zlecenia, które już jest w bazie — ma trafić jako dopięcie
  // dokumentu, a nie jako drugie, osobne zlecenie.
  const result = assessRelevance(
    mail({ subject: "ZD/1797/6/2026 list przewozowy", attachments: PDF }),
    LOADS,
    new Map(),
  );
  assertEquals(result.matchedLoadId, "load-1");
});
