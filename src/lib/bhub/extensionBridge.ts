// Most między appką a rozszerzeniem do Chrome, które sprawdza statusy w Baltic Hub.
//
// DLACZEGO PRZEZ ROZSZERZENIE, a nie prosto z appki: baltichub.com jest na innej domenie i nie
// wystawia nagłówków CORS, więc kod strony nie odczyta jego odpowiedzi, choćby dyspozytor był
// zalogowany. Rozszerzenie ma do tego uprawnienie (`host_permissions`) i — co ważniejsze —
// otwiera prawdziwą kartę, więc Cloudflare i reCAPTCHA widzą zwykłego człowieka.
//
// Rozmowa idzie przez `chrome.runtime.sendMessage(ID, ...)`, którą rozszerzenie przyjmuje tylko
// z adresów wpisanych w jego `externally_connectable`. Stąd STAŁY identyfikator: bierze się
// z klucza publicznego w `manifest.json`, więc jest ten sam na każdym komputerze i nie zmienia się
// przy ponownym wgraniu rozszerzenia.

export const ROZSZERZENIE_ID = "jaiopbejoakjdggjpkgoambeifcjjffj";

const LIMIT_STANU_MS = 4_000;
// Przebieg to kilka paczek po ~1,5 minuty (Cloudflare potrafi weryfikować kilkadziesiąt sekund),
// więc czekamy długo. To nie blokuje tabeli: wyniki i tak wracają na bieżąco przez Realtime.
const LIMIT_PRZEBIEGU_MS = 10 * 60_000;

interface ChromeRuntime {
  sendMessage: (id: string, message: unknown, callback: (odpowiedz: unknown) => void) => void;
  lastError?: { message?: string };
}

export interface StanRozszerzenia {
  zainstalowane: boolean;
  zalogowane: boolean;
  email: string | null;
  /** Wersja z `manifest.json` TEJ instalacji — po niej appka pozna, że dyspozytor ma starą wtyczkę. */
  wersja: string | null;
  trwa: boolean;
  powod: string | null;
}

export type WynikSprawdzenia =
  | { ok: true; checked: number }
  | { ok: false; reason: "brak_rozszerzenia" | "blad"; error: string };

function runtime(): ChromeRuntime | null {
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return typeof chrome?.runtime?.sendMessage === "function" ? chrome.runtime : null;
}

/**
 * Jedno zapytanie do rozszerzenia. `lastError` MUSI zostać odczytany w wywołaniu zwrotnym —
 * inaczej Chrome wypisuje ostrzeżenie do konsoli, a my i tak nie poznajemy powodu (brak
 * rozszerzenia wygląda wtedy identycznie jak jego błąd).
 */
function zapytaj<T>(wiadomosc: unknown, limitMs: number): Promise<{ ok: true; dane: T } | { ok: false; brak: boolean; error: string }> {
  const rt = runtime();
  if (!rt) {
    return Promise.resolve({
      ok: false,
      brak: true,
      error: "Nie widzę rozszerzenia „Grabowski — statusy kontenerów”. Zainstaluj je w Chrome (katalog `extension` w repozytorium).",
    });
  }

  return new Promise((resolve) => {
    let rozstrzygniete = false;
    const zegar = setTimeout(() => {
      if (rozstrzygniete) return;
      rozstrzygniete = true;
      resolve({ ok: false, brak: false, error: "Rozszerzenie nie odpowiedziało na czas." });
    }, limitMs);

    rt.sendMessage(ROZSZERZENIE_ID, wiadomosc, (odpowiedz) => {
      if (rozstrzygniete) return;
      rozstrzygniete = true;
      clearTimeout(zegar);
      const blad = rt.lastError?.message;
      if (blad || odpowiedz === undefined) {
        resolve({
          ok: false,
          brak: true,
          error:
            "Nie widzę rozszerzenia „Grabowski — statusy kontenerów” w tej przeglądarce. " +
            "Zainstaluj je albo włącz — bez niego statusy z Baltic Hub nie będą się odświeżać.",
        });
        return;
      }
      resolve({ ok: true, dane: odpowiedz as T });
    });
  });
}

export async function bhubExtensionState(): Promise<StanRozszerzenia> {
  const wynik = await zapytaj<{
    ok?: boolean;
    wersja?: string;
    konto?: { email?: string } | null;
    trwa?: boolean;
    ostatni?: { blad?: string | null };
  }>({ typ: "stan" }, LIMIT_STANU_MS);
  if (!wynik.ok) return { zainstalowane: false, zalogowane: false, email: null, wersja: null, trwa: false, powod: wynik.error };
  return {
    zainstalowane: true,
    zalogowane: Boolean(wynik.dane?.konto),
    email: wynik.dane?.konto?.email ?? null,
    wersja: wynik.dane?.wersja ?? null,
    trwa: Boolean(wynik.dane?.trwa),
    powod: wynik.dane?.konto ? null : "Rozszerzenie nie jest zalogowane — otwórz je i podaj e-mail oraz hasło do appki.",
  };
}

/**
 * Prośba o sprawdzenie. Wynik NIE wraca tędy do tabeli — rozszerzenie odsyła odczyt do funkcji
 * `bhub-status`, ta zapisuje go przy zleceniach, a Zestawienie dostaje zmianę przez Realtime.
 * Tutaj interesuje nas wyłącznie „udało się / nie udało" i powód dla dyspozytora.
 */
export async function requestBhubCheck(loadIds?: string[]): Promise<WynikSprawdzenia> {
  const wynik = await zapytaj<{ ok?: boolean; checked?: number; error?: string; problems?: string[] }>(
    { typ: "sprawdz-teraz", loadIds: loadIds ?? null, powod: "guzik w appce" },
    LIMIT_PRZEBIEGU_MS,
  );
  if (!wynik.ok) return { ok: false, reason: wynik.brak ? "brak_rozszerzenia" : "blad", error: wynik.error };

  const dane = wynik.dane;
  if (!dane?.ok) {
    return { ok: false, reason: "blad", error: dane?.error ?? dane?.problems?.[0] ?? "Nieznany błąd sprawdzenia." };
  }
  return { ok: true, checked: dane.checked ?? 0 };
}
