// Pisanie i klikanie JAK CZŁOWIEK — prawdziwe zdarzenia myszy i klawiatury generowane przez samą
// przeglądarkę (protokół debugowania Chrome), a nie z kodu strony.
//
// PO CO, zmierzone na produkcji: nasze zapytania dochodziły do Baltic Hubu PUSTE. Terminal
// odpowiadał „Brak wyników:" bez numeru, podczas gdy to samo wyszukiwanie zrobione ręcznie przez
// dyspozytora wracało z „Brak wyników dla: CAAU2300808" (z numerem) albo z kartą kontenera.
// Formularz jest chroniony reCAPTCHĄ, a ta nie rusza przy kliknięciu wywołanym z kodu:
// `element.click()` tworzy zdarzenie z `isTrusted === false`. Serwis nie zwraca wtedy błędu —
// po prostu oddaje pustą listę, co przez trzy rundy wyglądało jak „terminal nie zna kontenera".
//
// `chrome.debugger` wysyła zdarzenia z poziomu przeglądarki, więc strona (i reCAPTCHA) widzą je
// dokładnie tak jak ruch prawdziwego człowieka. Kosztem jest pasek „Rozszerzenie debuguje tę
// kartę" nad przypiętą kartą terminala — świadoma cena za działający odczyt.
//
// Gdy podłączenie się nie uda (ktoś ma otwarte narzędzia deweloperskie na tej karcie, bo do
// jednej karty może być podłączony tylko jeden debuger), przebieg NIE pada: wraca informacja
// o niepowodzeniu, a `background.js` próbuje starą drogą i zapisuje w migawce, którą poszedł.

const PROTOKOL = "1.3";

const spij = (ms) => new Promise((r) => setTimeout(r, ms));

function polecenie(kartaId, metoda, parametry = {}) {
  return chrome.debugger.sendCommand({ tabId: kartaId }, metoda, parametry);
}

/** Ruch myszy + klik w podany punkt. Ruch przed klikiem, bo po samym „teleporcie" kursora część
 *  zabezpieczeń uznaje zachowanie za automat. */
async function klik(kartaId, punkt) {
  const wspolne = { x: punkt.x, y: punkt.y, button: "left", buttons: 1, clickCount: 1 };
  await polecenie(kartaId, "Input.dispatchMouseEvent", { ...wspolne, type: "mouseMoved", buttons: 0 });
  await spij(60);
  await polecenie(kartaId, "Input.dispatchMouseEvent", { ...wspolne, type: "mousePressed" });
  await spij(40);
  await polecenie(kartaId, "Input.dispatchMouseEvent", { ...wspolne, type: "mouseReleased" });
}

async function enter(kartaId) {
  const klawisz = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await polecenie(kartaId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...klawisz });
  await polecenie(kartaId, "Input.dispatchKeyEvent", { type: "char", text: "\r", ...klawisz });
  await polecenie(kartaId, "Input.dispatchKeyEvent", { type: "keyUp", ...klawisz });
}

/**
 * Klika w pole, wpisuje tekst i klika w guzik — wszystko zdarzeniami przeglądarki.
 * `wskazniki` to punkty zmierzone na stronie (patrz `__bhub.wskazniki` w page.js).
 */
export async function wpiszJakCzlowiek(kartaId, wskazniki, tekst) {
  await chrome.debugger.attach({ tabId: kartaId }, PROTOKOL);
  try {
    await klik(kartaId, wskazniki.pole);
    await spij(150);

    // `Input.insertText` wpisuje całość naraz i jest tańsze niż literowanie po znaku, a dla strony
    // wygląda jak wklejenie. Terminal przyjmuje wklejony numer — właściciel tak właśnie sprawdzał
    // ręcznie („skopiowałem wartość z tabeli").
    await polecenie(kartaId, "Input.insertText", { text: tekst });
    await spij(250);

    if (wskazniki.guzik) {
      await klik(kartaId, wskazniki.guzik);
    } else {
      await enter(kartaId);
    }
    return { ok: true, sposob: wskazniki.guzik ? "zaufany klik w guzik" : "zaufany Enter" };
  } finally {
    await chrome.debugger.detach({ tabId: kartaId }).catch(() => undefined);
  }
}
