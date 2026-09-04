// ============================================================
// background.js — cała orkiestracja rozszerzenia.
//
// PRZEBIEG: funkcja `bhub-status` mówi, o które kontenery pytać → otwieramy stronę terminala
// w karcie tej przeglądarki → wpisujemy numery i klikamy → czytamy widoczny tekst → odsyłamy go
// do funkcji, która go rozumie i zapisuje przy zleceniach.
//
// DLACZEGO TO MA STAĆ W PRZEGLĄDARCE DYSPOZYTORA: baltichub.com odrzuca ruch z serwerowni
// (Cloudflare + reCAPTCHA — zmierzone na trzech niezależnych drogach). Prawdziwa przeglądarka,
// zalogowany człowiek, zwykłe łącze — i problem znika u źródła. Ta sama maszyneria zadziała
// u kolejnych terminali, które też będą się bronić, a API nie każdy da.
//
// UWAGA NA CZAS ŻYCIA SERVICE WORKERA (MV3): Chrome usypia go po ~30 s bezczynności, ale KAŻDE
// wywołanie API rozszerzenia ten czas resetuje. Nasze pętle czekania odpytują stronę przez
// `chrome.scripting.executeScript` co 1,5 s, więc worker żyje przez cały przebieg. Gdyby ktoś
// zamienił to na zwykłe `setTimeout` bez wywołań API — przebieg zacząłby ginąć w połowie.
// ============================================================

import { konto, ustawienia, wywolaj, zaloguj, wyloguj } from "./api.js";
import { konfiguracjaTerminala } from "./config.js";
import { wpiszJakCzlowiek } from "./input.js";
import { odpowiedzDotyczyNas } from "./odpowiedz.js";

const ALARM = "sprawdzanie";
const CZEKANIE_NA_POLE_MS = 90_000; // Cloudflare potrafi weryfikować kilkadziesiąt sekund.
const CZEKANIE_NA_WYNIKI_MS = 60_000;
/** Ile z tego czasu daje pierwsze podejście (klik), zanim spróbujemy Enterem. */
const CZEKANIE_NA_PIERWSZE_MS = 20_000;
const KROK_MS = 1500;

// Jeden przebieg naraz. Dwa (alarm + „Sprawdź teraz" z appki) wpisywałyby numery w to samo pole.
let trwa = false;

// ---------------------------------------------------------------- narzędzia

const spij = (ms) => new Promise((r) => setTimeout(r, ms));

function paczki(lista, ile) {
  const out = [];
  for (let i = 0; i < lista.length; i += ile) out.push(lista.slice(i, i + ile));
  return out;
}

/** Błąd, który niesie ze sobą migawkę strony (trafia do `bhub_details` przy zleceniu). */
function bladZeSzczegolami(komunikat, szczegoly, wymagaCzlowieka = false) {
  const e = new Error(komunikat);
  e.szczegoly = szczegoly;
  e.wymagaCzlowieka = wymagaCzlowieka;
  return e;
}

async function zapiszStan(patch) {
  const { ostatni } = await chrome.storage.local.get("ostatni");
  const nowy = { ...(ostatni ?? {}), ...patch, kiedy: new Date().toISOString() };
  await chrome.storage.local.set({ ostatni: nowy });
  await chrome.action.setBadgeBackgroundColor({ color: patch.blad ? "#b91c1c" : "#15803d" });
  await chrome.action.setBadgeText({ text: patch.blad ? "!" : "" });
  return nowy;
}

function powiadom(tytul, tresc) {
  chrome.notifications?.create("bhub", {
    type: "basic",
    iconUrl: "icon128.png",
    title: tytul,
    message: tresc.slice(0, 250),
    priority: 2,
  });
}

// ---------------------------------------------------------------- karta z terminalem

/**
 * Karta ze stroną terminala. Jedna na całe rozszerzenie: przypięta i nieaktywna, żeby nie
 * zabierać dyspozytorowi tego, na co właśnie patrzy. Gdy ktoś ją zamknie — otwieramy nową.
 */
async function dajKarte(adres) {
  const { kartaId } = await chrome.storage.local.get("kartaId");
  if (kartaId) {
    const karta = await chrome.tabs.get(kartaId).catch(() => null);
    if (karta) return karta.id;
  }
  const karta = await chrome.tabs.create({ url: adres, active: false, pinned: true });
  await chrome.storage.local.set({ kartaId: karta.id });
  return karta.id;
}

/** Kod ze `page.js` wchodzi na stronę przy KAŻDYM wywołaniu — po przeładowaniu strony znika. */
async function naStronie(kartaId, nazwa, argumenty = []) {
  await chrome.scripting.executeScript({ target: { tabId: kartaId }, files: ["page.js"] });
  const [wynik] = await chrome.scripting.executeScript({
    target: { tabId: kartaId },
    func: (n, a) => {
      const api = globalThis.__bhub;
      if (!api || typeof api[n] !== "function") return { _brakKodu: true };
      return api[n](...a);
    },
    args: [nazwa, argumenty],
  });
  const dane = wynik?.result;
  if (dane?._brakKodu) throw new Error("Nie udało się wstrzyknąć kodu na stronę terminala.");
  return dane ?? {};
}

/**
 * Czeka, aż coś na stronie będzie prawdą. Zwraca ostatni odczyt także przy niepowodzeniu.
 *
 * Błąd wstrzyknięcia NIE kończy czekania: w trakcie przeładowania strony (a Cloudflare przeładowuje
 * ją sam, i to kilka razy) `executeScript` potrafi rzucić „Frame with given id not found". To jest
 * stan przejściowy, nie awaria — traktujemy go jak „jeszcze nie gotowe" i próbujemy dalej, aż do
 * końca limitu. Ostatni powód zostaje, żeby było co pokazać, gdy limit jednak minie.
 */
async function czekaj(kartaId, nazwa, gotowe, limitMs) {
  const koniec = Date.now() + limitMs;
  let stan = {};
  for (;;) {
    try {
      stan = await naStronie(kartaId, nazwa);
      if (gotowe(stan)) return { ok: true, stan };
    } catch (e) {
      stan = { _powod: e.message };
    }
    if (Date.now() > koniec) return { ok: false, stan };
    await spij(KROK_MS);
  }
}

/**
 * Wejście na ŚWIEŻĄ stronę terminala — z czekaniem, aż to naprawdę będzie NOWY dokument.
 *
 * TU SIEDZIAŁ BŁĄD ZGŁOSZONY PRZEZ WŁAŚCICIELA („pojedynczy kontener czyta bezbłędnie, przy kilku
 * się gubi"). `chrome.tabs.update` tylko ZLECA wejście na stronę i wraca od razu. Poprzednia wersja
 * sprawdzała potem wyłącznie, czy adres karty pasuje do hosta terminala — a stary dokument (ten
 * z wynikami POPRZEDNIEGO kontenera) ma dokładnie ten sam adres i wciąż ma pole na numery, więc
 * warunek spełniał się NATYCHMIAST, jeszcze przed nawigacją. Przy pierwszym kontenerze nie było
 * czego pomylić — karta dopiero powstawała — i dlatego pojedyncze sprawdzenie zawsze wychodziło.
 * Przy drugim i kolejnym rozszerzenie pracowało na stronie, która za chwilę znikała: albo numer
 * przepadał razem z nią (60 s czekania na wyniki, których nikt nie zamówił), albo z ekranu szła do
 * serwera karta poprzedniego kontenera.
 *
 * Dlatego stary dokument jest NAJPIERW ZNACZONY (`oznaczStary`), a potem czekamy, aż zobaczymy
 * dokument BEZ tego znacznika, wczytany do końca i pod właściwym adresem.
 */
async function wejdzNaStrone(kartaId, adres, host) {
  await naStronie(kartaId, "oznaczStary").catch(() => undefined);
  await chrome.tabs.update(kartaId, { url: adres });

  const swieza = (s) => s.stary === false && s.wczytana === true && (s.adres ?? "").includes(host);
  const wynik = await czekaj(kartaId, "stan", swieza, 30_000);
  if (wynik.ok) return wynik;

  // Nawigacja się nie zaczęła (potrafi tak być, gdy adres jest identyczny z bieżącym). Wymuszamy
  // przeładowanie — to ostatnia rzecz, która może odświeżyć stronę bez udziału człowieka.
  await chrome.tabs.reload(kartaId).catch(() => undefined);
  return czekaj(kartaId, "stan", swieza, 30_000);
}

/**
 * Jedna paczka numerów: wejście na stronę, wpisanie, klik, odczytanie wyników.
 * Zwraca widoczny tekst strony — rozumie go funkcja brzegowa (`parse.ts`), nie rozszerzenie.
 * Podział jest celowy: reguły odczytu terminala mają być w JEDNYM miejscu, po stronie serwera,
 * żeby poprawka nie wymagała aktualizacji rozszerzenia na każdym komputerze.
 */
async function zapytajTerminal(kartaId, terminal, numery, proba = 1) {
  const adres = terminal.adres;
  // Czekamy na host Z USTAWIEŃ, nie na wpisane na sztywno "baltichub" — adres jest polem w oknie
  // rozszerzenia właśnie po to, żeby dało się go przestawić przy kolejnym terminalu.
  const host = new URL(adres).host;
  const swieza = await wejdzNaStrone(kartaId, adres, host);
  if (!swieza.ok) {
    throw bladZeSzczegolami(
      `Karta z Baltic Hubem nie wczytała się na nowo w ciągu 60 s (adres: „${swieza.stan.adres ?? "?"}”). ` +
        `Sprawdź, czy przypięta karta terminala nie jest zablokowana oknem przeglądarki.`,
      { _etap: "strona nie wczytała się na nowo", ...swieza.stan },
    );
  }

  const gotowa = await czekaj(kartaId, "stan", (s) => s.gotowa && !s.stary, CZEKANIE_NA_POLE_MS);
  if (!gotowa.ok) {
    const cloudflare = /just a moment|cierpliwo|verify|weryfik/i.test(`${gotowa.stan.tytul} ${gotowa.stan.tekst}`);
    throw bladZeSzczegolami(
      cloudflare
        ? `Strona Baltic Hub nie przeszła weryfikacji Cloudflare w ciągu 90 s (tytuł: „${gotowa.stan.tytul ?? ""}”). ` +
            `Otwórz przypiętą kartę i przejdź weryfikację ręcznie — kolejne sprawdzenia pójdą już same.`
        : `Na stronie Baltic Hub nie pojawiło się pole na numery kontenerów w ciągu 90 s ` +
            `(tytuł: „${gotowa.stan.tytul ?? ""}”).`,
      { _etap: "brak pola na numery", ...gotowa.stan },
      cloudflare,
    );
  }

  // Zgoda na ciasteczka przykrywa stronę przezroczystą warstwą, która przechwytuje każde
  // kliknięcie — bez jej zamknięcia klik w „Sprawdź" nie robi nic, a strona wygląda na sprawną.
  const okienka = await naStronie(kartaId, "zamknij");

  // Oddech przed pisaniem. Zmierzone na produkcji: trzy pierwsze kontenery w przebiegu wróciły
  // z pustą odpowiedzią, a dwa ostatnie z pełnymi kartami — reCAPTCHA po prostu nie zdążyła się
  // uruchomić przy pierwszych wejściach na stronę. Te trzy sekundy są tańsze niż przebieg,
  // który zapisuje przy zleceniu nieprawdę.
  await spij(3000);

  // Wpisanie i uruchomienie wyszukiwania. NAJPIERW droga „jak człowiek" (prawdziwe zdarzenia myszy
  // i klawiatury), bo tylko ona uruchamia reCAPTCHĘ formularza — bez niej terminal oddaje pustą
  // listę wyników, co wygląda jak „nie zna kontenera". Stara droga (klik z kodu) zostaje jako
  // awaryjna: gdy nie da się podłączyć debugera, lepiej spróbować niż nie zrobić nic.
  const ustawienie = await naStronie(kartaId, "ustawTryb", [numery.length]);
  await spij(400);
  const wsk = await naStronie(kartaId, "wskazniki");

  // Okno na stronę dla `input.js` — po to, żeby po każdym podejściu dało się sprawdzić, co
  // NAPRAWDĘ stoi w polu, zamiast wysyłać formularz w ciemno.
  const narzedzia = {
    stanPola: () => naStronie(kartaId, "stanPola"),
    skupPole: () => naStronie(kartaId, "skupPole"),
    czyscPole: () => naStronie(kartaId, "czyscPole"),
  };

  let wyslane;
  if (wsk.ok) {
    try {
      const zaufane = await wpiszJakCzlowiek(kartaId, wsk, numery.join(terminal.rozdzielnik), narzedzia);
      wyslane = {
        wyslane: true,
        sposob: zaufane.sposob,
        tryb: `${ustawienie.opis ?? "?"} :: ${wsk.tryb ?? "?"}`,
        pole: wsk.opisPola,
        guzik: wsk.opisGuzika,
        wpisano: numery.join(terminal.rozdzielnik),
        wpolu: zaufane.wpolu,
        fokusKarty: zaufane.fokusKarty,
        kandydaci: wsk.kandydaci,
      };
    } catch (e) {
      wyslane = await naStronie(kartaId, "wyslij", [numery]);
      wyslane.sposob = `${wyslane.sposob ?? "?"} (droga awaryjna, debuger: ${e.message})`;
    }
  } else {
    wyslane = await naStronie(kartaId, "wyslij", [numery]);
    wyslane.sposob = `${wyslane.sposob ?? "?"} (bez zaufanych zdarzeń: ${wsk.powod ?? "nie zmierzyłem punktu do kliknięcia"})`;
  }

  // Ostatnie spojrzenie na pole PO wysłaniu. Nie zatrzymuje przebiegu — strona po wyszukaniu
  // potrafi pole wyczyścić — ale ląduje w migawce, więc „terminal nie zna kontenera" da się
  // odróżnić od „zapytanie poszło puste" bez zgadywania.
  wyslane.poWyslaniu = await naStronie(kartaId, "stanPola").catch(() => null);

  if (!wyslane.wyslane) {
    const blad = bladZeSzczegolami(
      `Nie udało się uruchomić wyszukiwania: ${wyslane.powod ?? "nieznany powód"}. Tryb: ${wyslane.tryb ?? "?"}.`,
      { _etap: "nie udało się uruchomić wyszukiwania", _okienka: JSON.stringify(okienka), ...wyslane },
    );
    // Nie udało się przestawić strony na „wiele kontenerów" — przebieg leci dalej, ale po jednym.
    blad.trybNieustawiony = Boolean(wyslane.trybNieustawiony);
    throw blad;
  }

  // Pierwsze podejście: to, co zrobił `wyslij` (klik w guzik albo wysłanie formularza).
  //
  // CZEKAMY NA ODPOWIEDŹ, KTÓRA DOTYCZY NAS — nie na samo pojawienie się sekcji wyników.
  // Zmierzone u właściciela: strona najpierw pokazuje pustą sekcję „Brak wyników:", a kartę
  // kontenera dorzuca chwilę później. Warunek „widać sekcję wyników" łapał się na to pierwsze
  // i zabierał migawkę o sekundę za wcześnie — dane były na ekranie, a przy zleceniu lądowało
  // „Baltic Hub nie zna kontenera". Karta albo „Brak wyników dla: <nasz numer>" to jedyne dwa
  // stany, które faktycznie kończą wyszukiwanie.
  // Odpowiedź jest nasza, gdy widać NASZ numer ORAZ ślad, którego na pustej stronie nie ma
  // (karta kontenera / nagłówek tabeli wyników — patrz `markerWynikow` w config.js). Sam numer nie
  // wystarcza: u GCT numery wpisujemy w pole tekstowe, którego treść też jest w tekście strony.
  const marker = new RegExp(terminal.markerWynikow, "i");
  const dotyczyNas = (s) => odpowiedzDotyczyNas(s.tekst ?? "", numery) && marker.test(s.tekst ?? "");
  let wyniki = await czekaj(kartaId, "wyniki", dotyczyNas, CZEKANIE_NA_PIERWSZE_MS);

  // Drugie podejście: Enter w polu. Na tej stronie kontrolka uruchamiająca wyszukiwanie NIE jest
  // zwykłym guzikiem (spis guzików całej strony nie zawierał ani jednego „Sprawdź" — same przyciski
  // ciasteczek), więc klik mógł trafić w nic. Pole jest już wypełnione, więc to nic nie psuje.
  let drugie = null;
  if (!wyniki.ok) {
    // ...ale TYLKO gdy pole faktycznie coś zawiera. Przy pustym polu Enter wyszukałby pustkę
    // i terminal odpowiedziałby „Brak wyników:" bez numeru — czyli dokładnie tym, co przez kilka
    // rund wyglądało jak „nie zna kontenera". Puste pole wypełniamy więc jeszcze raz, drogą
    // z kodu: bez zaufanych zdarzeń, ale zapytanie z numerem bije zapytanie puste.
    const wPolu = (wyslane.poWyslaniu?.wartosc ?? "").trim();
    drugie = await naStronie(kartaId, "wyslij", [numery, { enter: Boolean(wPolu) }]).catch((e) => ({ powod: e.message }));
    wyniki = await czekaj(kartaId, "wyniki", dotyczyNas, CZEKANIE_NA_WYNIKI_MS - CZEKANIE_NA_PIERWSZE_MS);
  }

  if (!wyniki.ok) {
    const zagadka = wyniki.stan.zagadka?.czekaNaCzlowieka;
    const zgodaWisi = okienka.zgodaNadalOtwarta;

    // Strona ODPOWIEDZIAŁA, ale nie o naszym kontenerze — czyli zapytanie doszło puste (reCAPTCHA
    // nie zdążyła się uruchomić; terminal oddaje wtedy samo „Brak wyników:" bez numeru). Druga
    // próba na świeżo wczytanej stronie zwykle wraca z kartą, więc zanim zapiszemy błąd przy
    // zleceniu, próbujemy raz jeszcze. Przy zagadce nie ma sensu — tam czeka się na człowieka.
    if (marker.test(wyniki.stan.tekst ?? "") && !zagadka && !zgodaWisi && proba < 2) {
      await spij(2000);
      return zapytajTerminal(kartaId, terminal, numery, proba + 1);
    }

    throw bladZeSzczegolami(
      zagadka
        ? "Baltic Hub poprosił o rozwiązanie zagadki (reCAPTCHA). Otwórz przypiętą kartę i kliknij ją — " +
            "kolejne sprawdzenia pójdą już same."
        : zgodaWisi
          ? "Nad stroną Baltic Hub wisi okno zgody na ciasteczka i przykrywa formularz. Otwórz przypiętą " +
            "kartę, zaakceptuj je raz ręcznie — kolejne sprawdzenia pójdą już same."
          : `Wyszukiwanie uruchomione (${wyslane.sposob}), ale wyniki nie pojawiły się w ciągu 60 s. ` +
            `W polu stało: „${wyslane.poWyslaniu?.wartosc ?? "?"}”. Pole: ${wyslane.pole ?? "?"}. ` +
            `Guzik: ${wyslane.guzik ?? "?"}. Migawka strony zapisana do diagnozy.`,
      {
        _etap: "brak wyników",
        _pole_po_wyslaniu: JSON.stringify(wyslane.poWyslaniu ?? {}),
        _okienka: JSON.stringify(okienka),
        _zagadka: JSON.stringify(wyniki.stan.zagadka ?? {}),
        _drugie_podejscie: JSON.stringify(drugie ?? {}),
        ...wyslane,
        ...wyniki.stan,
      },
      Boolean(zagadka) || Boolean(zgodaWisi),
    );
  }

  // Obok tekstu wracają dwie rzeczy do migawki przy zleceniu: KTÓRĄ drogą poszło wpisanie i CO
  // stało w polu. Bez nich udany przebieg nie zostawia żadnego śladu po tym, czy zaufane pisanie
  // w ogóle zadziałało — a to pierwsza rzecz, o którą trzeba zapytać, gdy odczyt zacznie się psuć.
  return {
    tekst: wyniki.stan.tekst ?? "",
    sposob: `${terminal.nazwa}: ${wyslane.sposob ?? "?"}`,
    wPolu: wyslane.poWyslaniu?.wartosc ?? null,
  };
}

// ---------------------------------------------------------------- przebieg

export async function przebieg({ powod = "harmonogram", loadIds = null } = {}) {
  if (trwa) return { ok: false, error: "Sprawdzanie właśnie trwa." };
  trwa = true;
  const cfg = await ustawienia();
  let sprawdzone = 0;
  const problemy = [];

  try {
    // Funkcja pilnuje okna godzinowego (dni robocze 6-18) dla przebiegu cyklicznego; przy prośbie
    // o konkretne zlecenia okno nie obowiązuje — człowiek ma dostać odpowiedź, kiedy pyta.
    const { items = [], window: wOknie = true, skipped } = await wywolaj("pending", loadIds ? { loadIds } : {});
    if (items.length === 0) {
      await wywolaj("heartbeat", { checked: 0 });
      const stan = await zapiszStan({ blad: null, sprawdzone: 0, powod, uwaga: skipped ?? (wOknie ? "nic do sprawdzenia" : null) });
      return { ok: true, checked: 0, stan };
    }

    // GRUPUJEMY PO TERMINALACH. Serwer przysyła przy każdym zleceniu nazwę terminala (z „Podjęcia"),
    // a każdy terminal ma inny adres, inny rozmiar paczki i inny ślad gotowej odpowiedzi.
    // Zlecenie z terminalem, którego rozszerzenie nie zna, NIE ginie po cichu — dostaje błąd.
    const grupy = new Map();
    const nieznane = [];
    for (const i of items) {
      const t = konfiguracjaTerminala((i.terminal ?? "BHub").trim(), cfg.zapisane);
      if (!t) {
        nieznane.push(i);
        continue;
      }
      if (!grupy.has(t.nazwa)) grupy.set(t.nazwa, { terminal: t, zlecenia: [] });
      grupy.get(t.nazwa).zlecenia.push(i);
    }

    if (nieznane.length) {
      const powodBledu =
        "Rozszerzenie nie zna tego terminala — zaktualizuj wtyczkę w chrome://extensions " +
        "(guzik Wtyczka w appce).";
      problemy.push(powodBledu);
      await wywolaj("report", {
        results: nieznane.map((i) => ({ loadId: i.loadId, container: i.container, error: powodBledu })),
      }).catch(() => undefined);
    }

    const kartaId = await dajKarte([...grupy.values()][0]?.terminal.adres ?? "about:blank");

    for (const { terminal, zlecenia } of grupy.values()) {
    for (const paczka of paczki(zlecenia, Number(cfg.rozmiarPaczki) || terminal.rozmiarPaczki)) {
      const numery = paczka.map((i) => i.container);
      try {
        let wyniki;
        try {
          const odp = await zapytajTerminal(kartaId, terminal, numery);
          wyniki = paczka.map((i) => ({ ...i, ...odp, text: odp.tekst, batchSize: numery.length }));
        } catch (e) {
          // Strona nie dała się przestawić na „wiele kontenerów" — pytamy po jednym. Wolniej
          // i drożej w czasie, ale przebieg kończy się wynikiem zamiast błędem przy pięciu
          // zleceniach naraz.
          if (!e.trybNieustawiony || numery.length === 1) throw e;
          wyniki = [];
          for (const i of paczka) {
            const odp = await zapytajTerminal(kartaId, terminal, [i.container]);
            wyniki.push({ ...i, ...odp, text: odp.tekst, batchSize: 1 });
          }
        }

        await wywolaj("report", {
          results: wyniki.map((i) => ({
            loadId: i.loadId,
            container: i.container,
            terminal: terminal.nazwa,
            text: i.text,
            batchSize: i.batchSize,
            details: {
              _paczka: numery.join(", "),
              _pytane_pojedynczo: String(i.batchSize === 1 && numery.length > 1),
              _sposob: i.sposob ?? "?",
              _w_polu: i.wPolu ?? "(nie sprawdzono)",
            },
          })),
        });
        sprawdzone += paczka.length;
      } catch (e) {
        problemy.push(e.message);
        // Błąd dotyczy CAŁEJ paczki — zapisujemy go przy każdym jej zleceniu. Zlecenie bez
        // sprawdzenia i bez śladu wygląda jak sprawdzone, a to najgorszy możliwy wynik.
        await wywolaj("report", {
          results: paczka.map((i) => ({
            loadId: i.loadId,
            container: i.container,
            terminal: terminal.nazwa,
            error: e.message,
            details: { ...(e.szczegoly ?? {}), _paczka: numery.join(", "), _terminal: terminal.nazwa },
          })),
        }).catch(() => undefined);

        if (e.wymagaCzlowieka) {
          // Cloudflare albo zagadka: dalsze paczki odbiją się tak samo. Prosimy człowieka
          // i kończymy — reszta zleceń zachowuje stary `bhub_checked_at`, więc w kolejnym
          // przebiegu stoi pierwsza w kolejce.
          powiadom(`${terminal.nazwa} czeka na Ciebie`, e.message);
          break;
        }
      }
    }
    }

    await wywolaj("heartbeat", { checked: sprawdzone, error: problemy[0] ?? null });
    const stan = await zapiszStan({ blad: problemy[0] ?? null, sprawdzone, powod });
    return { ok: problemy.length === 0, checked: sprawdzone, problems: problemy, stan };
  } catch (e) {
    // Tu lądują błędy spoza samego odpytywania: brak logowania, wygasła sesja, brak sieci.
    problemy.push(e.message);
    await wywolaj("heartbeat", { checked: sprawdzone, error: e.message }).catch(() => undefined);
    const stan = await zapiszStan({ blad: e.message, sprawdzone, powod });
    return { ok: false, error: e.message, stan };
  } finally {
    trwa = false;
  }
}

// ---------------------------------------------------------------- wejścia

async function ustawAlarm() {
  const { coIleMinut } = await ustawienia();
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { periodInMinutes: coIleMinut, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ustawAlarm);
chrome.runtime.onStartup.addListener(ustawAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) przebieg({ powod: "harmonogram" });
});

chrome.notifications?.onClicked.addListener(async () => {
  const { kartaId } = await chrome.storage.local.get("kartaId");
  if (kartaId) chrome.tabs.update(kartaId, { active: true }).catch(() => undefined);
});

/** Wspólna obsługa wiadomości z okna rozszerzenia (wewnętrzne) i z appki (zewnętrzne). */
async function obsluz(wiadomosc) {
  switch (wiadomosc?.typ) {
    case "stan": {
      const { ostatni } = await chrome.storage.local.get("ostatni");
      return { ok: true, wersja: chrome.runtime.getManifest().version, konto: await konto(), trwa, ostatni: ostatni ?? null };
    }
    case "sprawdz-teraz":
      return przebieg({ powod: wiadomosc.powod ?? "na żądanie", loadIds: wiadomosc.loadIds ?? null });
    case "zaloguj":
      await zaloguj(wiadomosc.email, wiadomosc.haslo);
      await ustawAlarm();
      return { ok: true, konto: await konto() };
    case "wyloguj":
      await wyloguj();
      return { ok: true };
    case "ustaw":
      await chrome.storage.local.set(wiadomosc.wartosci ?? {});
      await ustawAlarm();
      return { ok: true, ustawienia: await ustawienia() };
    default:
      return { ok: false, error: `Nieznana wiadomość: ${wiadomosc?.typ ?? "(brak)"}.` };
  }
}

// `sendResponse` po `await` wymaga zwrócenia `true` — inaczej Chrome zamyka kanał, a appka
// dostaje pustą odpowiedź i wygląda to jak brak rozszerzenia.
chrome.runtime.onMessage.addListener((wiadomosc, _nadawca, odpowiedz) => {
  obsluz(wiadomosc).then(odpowiedz, (e) => odpowiedz({ ok: false, error: e.message }));
  return true;
});

chrome.runtime.onMessageExternal.addListener((wiadomosc, _nadawca, odpowiedz) => {
  obsluz(wiadomosc).then(odpowiedz, (e) => odpowiedz({ ok: false, error: e.message }));
  return true;
});
