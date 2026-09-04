// Odczyt karty kontenera — trzy rubryki dodane na prośbę właściciela (Time Out, Cargo Weight,
// Commodity Weight) plus straże na to, co już czytaliśmy.
//
//   deno test --allow-none supabase/functions/bhub-status/parse.test.ts
//
// Treść karty ma kształt PRAWDZIWEJ odpowiedzi `/multi` (etykieta: wartość, jedna po drugiej,
// wartości bywają puste tuż przed kolejną etykietą) — to na niej wyłożyła się pierwsza wersja
// odczytu, która szukała tabeli z nagłówkiem.

import { assertEquals } from "jsr:@std/assert@1";
import { parseContainerPage, parseTerminalPage } from "./parse.ts";

/** Karta jednego kontenera. `timeOut` pusty = kontener stoi na terminalu. */
function karta(opts: { numer: string; timeOut?: string; cargo?: string; commodity?: string; weight?: string }): string {
  return (
    `Karta kontenera ${opts.numer} ` +
    `Unit Nbr: ${opts.numer} Category: IMPRT Line Operator: MSC ISO Type: 22G1 Frght Kind: FCL ` +
    `Inbound Carrier: MSC ANNA Outbound Carrier: Time In: 2026-09-01 08:12 ` +
    `Time Out: ${opts.timeOut ?? ""} *Stops: ` +
    `DSK Number: 26BOUG3RE 2026-09-02 06:00 CEN Number: ` +
    `Commodity Weight [KG]: ${opts.commodity ?? "21500.0"} ` +
    `Cargo Weight [KG]: ${opts.cargo ?? "21500.0"} ` +
    `Weight [KG]: ${opts.weight ?? "23976.0"} ` +
    `Class: POD: GDN Inbound Mode: VSL Carrier Seal: PL0099887 T-State: Yard OH (cm): 0`
  );
}

Deno.test("kontener stojący na terminalu: Time Out pusty, wagi odczytane", () => {
  const p = parseContainerPage(karta({ numer: "OMTU2301120" }), "OMTU2301120");
  assertEquals(p.recognised, true);
  assertEquals(p.notFound, false);
  // PUSTY TEKST, nie null: „rubryka jest i jest pusta" to informacja, a null znaczy „nie wiem".
  assertEquals(p.timeOut, "");
  assertEquals(p.grossWeightKg, 23976);
  assertEquals(p.netWeightKg, 21500);
  assertEquals(p.commodityWeightKg, 21500);
  assertEquals(p.status, "ZP");
});

Deno.test("Time Out wypełniony — kontener opuścił terminal", () => {
  const p = parseContainerPage(karta({ numer: "OMTU2301120", timeOut: "2026-09-03 14:20" }), "OMTU2301120");
  assertEquals(p.timeOut, "2026-09-03 14:20");
});

Deno.test("waga celna różna od wagi towaru — obie odczytane osobno", () => {
  const p = parseContainerPage(karta({ numer: "OMTU2301120", cargo: "21500.0", commodity: "20800.0" }), "OMTU2301120");
  assertEquals(p.netWeightKg, 21500);
  assertEquals(p.commodityWeightKg, 20800);
});

Deno.test("STRAŻ: Cargo/Commodity NIE mogą podszyć się pod wagę brutto", () => {
  // "Cargo Weight [KG]" zawiera w sobie "Weight [KG]" — przy niedokładnym dopasowaniu waga towaru
  // poszłaby jako brutto, a ta jedzie na dokument przewozowy. Trzy różne liczby to rozstrzygają.
  const p = parseContainerPage(
    karta({ numer: "OMTU2301120", weight: "23976.0", cargo: "21500.0", commodity: "20800.0" }),
    "OMTU2301120",
  );
  assertEquals(p.grossWeightKg, 23976);
  assertEquals(p.netWeightKg, 21500);
  assertEquals(p.commodityWeightKg, 20800);
});

Deno.test("nierozpoznana odpowiedź: wszystkie nowe pola puste, recognised=false", () => {
  const p = parseContainerPage("<html><body>Cokolwiek innego</body></html>", "OMTU2301120");
  assertEquals(p.recognised, false);
  assertEquals(p.timeOut, null); // null = „nie odczytałem", nigdy spokojne „pusto"
  assertEquals(p.netWeightKg, null);
  assertEquals(p.commodityWeightKg, null);
});

Deno.test("terminal nie zna kontenera: nowe pola też puste", () => {
  const p = parseContainerPage("Sprawdź kontener Brak wyników dla: CAAU2300808", "CAAU2300808");
  assertEquals(p.notFound, true);
  assertEquals(p.recognised, true);
  assertEquals(p.timeOut, null);
  assertEquals(p.commodityWeightKg, null);
});

Deno.test("paczka kilku kart: każdy kontener dostaje SWOJE rubryki", () => {
  const strona =
    karta({ numer: "OMTU2301120", timeOut: "", cargo: "21500.0", commodity: "21500.0", weight: "23976.0" }) +
    " " +
    karta({ numer: "MBUU1000292", timeOut: "2026-09-02 11:05", cargo: "18000.0", commodity: "17200.0", weight: "20200.0" });

  const pierwszy = parseContainerPage(strona, "OMTU2301120");
  assertEquals(pierwszy.timeOut, "");
  assertEquals(pierwszy.netWeightKg, 21500);

  const drugi = parseContainerPage(strona, "MBUU1000292");
  assertEquals(drugi.timeOut, "2026-09-02 11:05");
  assertEquals(drugi.netWeightKg, 18000);
  assertEquals(drugi.commodityWeightKg, 17200);
  assertEquals(drugi.grossWeightKg, 20200);
});

// ============================================================
// BCT i GCT — na PRAWDZIWYCH odpowiedziach terminali (katalog `fixtures/`).
//
// Skąd fixtury: zapytanie poszło do terminala naprawdę (BCT: POST z tokenem `__RequestVerification
// Token`, GCT: POST z `PRADO_PAGESTATE`), a odpowiedź została zrenderowana w prawdziwym Chromium
// i zapisana jako `document.body.innerText` — czyli DOKŁADNIE to, co wtyczka przysyła serwerowi.
// ============================================================

const BCT = Deno.readTextFileSync(new URL("./fixtures/bct-MSBU3142439.txt", import.meta.url));
const GCT = Deno.readTextFileSync(new URL("./fixtures/gct-HMMU2345017.txt", import.meta.url));

Deno.test("BCT: karta kontenera odczytana z prawdziwej odpowiedzi", () => {
  const p = parseTerminalPage(BCT, "MSBU3142439", "BCT");
  assertEquals(p.recognised, true);
  assertEquals(p.notFound, false);
  assertEquals(p.grossWeightKg, 10250); // Weight [kg]
  assertEquals(p.netWeightKg, 8150); // Cargo Weight [kg]
  assertEquals(p.shippingLine, "MSC");
  assertEquals(p.isoType, "2210"); // stary, LICZBOWY zapis ISO — BCT tak podaje
  assertEquals(p.timeOut, "04.09.2026 01:21"); // niepusty → kontener opuścił terminal
});

Deno.test("BCT: mysliniki znacza PUSTO, nie blokade", () => {
  const p = parseTerminalPage(BCT, "MSBU3142439", "BCT");
  // Rubryka „Stops" ma w odpowiedzi „--". Gdyby przeszło to jako wartość, kontener wyszedłby
  // jako zablokowany — czyli „nie wolno zabierać" zamiast „brak blokad".
  assertEquals((p.details["Stops"] ?? "").trim(), "--");
  assertEquals(/stopk|hold/i.test(p.statusRaw ?? ""), false);
});

Deno.test("BCT: karta INNEGO kontenera nie jest naszą odpowiedzią", () => {
  const p = parseTerminalPage(BCT, "TEMU1234567", "BCT");
  assertEquals(p.recognised, false);
  assertEquals(p.notFound, false); // to NIE jest „terminal go nie zna"
});

Deno.test("GCT: wiersz tabeli odczytany z prawdziwej odpowiedzi", () => {
  const p = parseTerminalPage(GCT, "HMMU2345017", "GCT");
  assertEquals(p.recognised, true);
  assertEquals(p.notFound, false);
  assertEquals(p.isoType, "22G1");
  assertEquals(p.details["Status"], "na terminalu - w trakcie przyjęcia\neksport - pełny");
  assertEquals(p.details["Status celny"], "Do odprawy");
  assertEquals(p.details["Podróż"], "2624S, Annalisa P\nETA: 2026-09-10 10:00, ETD: 2026-09-11 15:00");
  // Kolumny sąsiadujące ze „Statusem" NIE mogą się w niego wlać — o granicy decyduje tabulator.
  assertEquals(p.details["Status"].includes("Do odprawy"), false);
});

Deno.test("GCT: Data/Czas podjecia to odpowiednik Time Out; twarda spacja = pusto", () => {
  const p = parseTerminalPage(GCT, "HMMU2345017", "GCT");
  assertEquals(p.timeOut, ""); // kontener jeszcze nie podjęty
  assertEquals(p.grossWeightKg, null); // GCT nie podaje wag
  assertEquals(p.shippingLine, null); // ani armatora
});

Deno.test("GCT: numeru spoza tabeli terminal nie zna", () => {
  const p = parseTerminalPage(GCT, "TEMU1234567", "GCT");
  assertEquals(p.notFound, true);
  assertEquals(p.recognised, true);
});

Deno.test("STRAŻ: cudzy parser nie czyta cudzej strony", () => {
  // Karta BCT przepuszczona parserem Baltic Hubu nie ma „Unit Nbr:", więc nie zostanie odczytana
  // jako komplet danych — zamiast wpisać przy zleceniu byle co, mówimy „nie rozpoznałem".
  assertEquals(parseTerminalPage(BCT, "MSBU3142439", "BHub").recognised, false);
  assertEquals(parseTerminalPage(GCT, "HMMU2345017", "BHub").recognised, false);
});

Deno.test("nieznany terminal = błąd konfiguracji, nazwany wprost", () => {
  const p = parseTerminalPage(BCT, "MSBU3142439", "DCT Gdańsk");
  assertEquals(p.recognised, false);
  assertEquals((p.reason ?? "").includes("DCT Gdańsk"), true);
});
