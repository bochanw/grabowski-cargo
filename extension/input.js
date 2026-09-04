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

/** Numer do porównania — strona bywa przystrojona spacjami, my wysyłamy je po przecinku. */
const goly = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Klika w pole, wpisuje tekst i klika w guzik — wszystko zdarzeniami przeglądarki.
 * `wskazniki` to punkty zmierzone na stronie (patrz `__bhub.wskazniki` w page.js).
 *
 * PO KAŻDYM PODEJŚCIU SPRAWDZAMY, CO NAPRAWDĘ STOI W POLU — zgłoszenie właściciela: „aplikacja
 * dalej ma tendencje do nie wpisywania w ogóle żadnego kontenera do wyszukiwania". Kod wysyłał
 * kliknięcie i tekst, po czym BEZ ŻADNEJ WERYFIKACJI klikał „Sprawdź": puste pole wyglądało wtedy
 * dokładnie tak samo jak wypełnione, a terminal odpowiadał „Brak wyników:" bez numeru — czyli
 * objawem błędu było „terminal nie zna kontenera". Funkcja `stanPola` służyła dokładnie do tego
 * rozstrzygnięcia i była w kodzie od początku, tylko NIKT JEJ NIE WOŁAŁ.
 *
 * Dwa podejścia, bo klik potrafi nie trafić w pole: współrzędne mierzymy PRZED podłączeniem
 * debugera (a to trwa), więc strona zdąży się przewinąć albo dołożyć nad polem warstwę. Drugie
 * podejście ustawia kursor wprost przez `focus()`.
 *
 * `narzedzia` to okno na stronę, którego `input.js` sam nie ma: `stanPola`, `skupPole`, `czyscPole`
 * (patrz `page.js`). Bez nich funkcja zachowuje się jak dotąd — pisze w ciemno.
 */
export async function wpiszJakCzlowiek(kartaId, wskazniki, tekst, narzedzia = {}) {
  await chrome.debugger.attach({ tabId: kartaId }, PROTOKOL);
  try {
    // Karta terminala jest PRZYPIĘTA I NIEAKTYWNA — dla strony to karta bez fokusu, a `document.
    // hasFocus()` w połowie zabezpieczeń znaczy „nikogo tu nie ma". To polecenie każe przeglądarce
    // udawać przed stroną, że karta jest na wierzchu, i nie zabiera dyspozytorowi tego, na co
    // patrzy. Gdyby go zabrakło (starszy Chrome), pracujemy dalej — stąd `catch`.
    const fokus = await polecenie(kartaId, "Emulation.setFocusEmulationEnabled", { enabled: true })
      .then(() => "tak")
      .catch((e) => `nie (${e.message})`);

    const podejscia = [];
    for (const sposob of ["zaufany klik w pole", "kursor przez focus()"]) {
      if (sposob === "zaufany klik w pole") await klik(kartaId, wskazniki.pole);
      else await narzedzia.skupPole?.();
      await spij(150);

      // `Input.insertText` wpisuje całość naraz i jest tańsze niż literowanie po znaku, a dla strony
      // wygląda jak wklejenie. Terminal przyjmuje wklejony numer — właściciel tak właśnie sprawdzał
      // ręcznie („skopiowałem wartość z tabeli").
      await polecenie(kartaId, "Input.insertText", { text: tekst });
      await spij(250);

      const stan = (await narzedzia.stanPola?.()) ?? null;
      podejscia.push(`${sposob} → „${stan ? stan.wartosc : "(nie sprawdzono)"}”`);

      // Brak `stanPola` (stara ścieżka) traktujemy jak sukces — inaczej odcinalibyśmy sobie
      // jedyną działającą drogę tylko dlatego, że nie umiemy jej sprawdzić.
      if (!stan || goly(stan.wartosc) === goly(tekst)) {
        if (wskazniki.guzik) await klik(kartaId, wskazniki.guzik);
        else await enter(kartaId);
        return {
          ok: true,
          sposob: `${sposob}, ${wskazniki.guzik ? "zaufany klik w guzik" : "zaufany Enter"}`,
          wpolu: stan?.wartosc ?? "(nie sprawdzono)",
          fokusKarty: fokus,
          stanPola: stan,
        };
      }

      // Numer nie trafił (albo trafił nie tam). Przed kolejnym podejściem czyścimy pole — inaczej
      // `insertText` dopisze numer do resztki i wyszukamy dwa numery sklejone w jeden.
      await narzedzia.czyscPole?.();
    }

    throw new Error(`numer nie trafił do pola — ${podejscia.join("; ")}; fokus karty: ${fokus}`);
  } finally {
    await chrome.debugger.detach({ tabId: kartaId }).catch(() => undefined);
  }
}
