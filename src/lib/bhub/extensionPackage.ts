// Paczka z wtyczką do Chrome, którą appka serwuje sama (guzik „Wtyczka" w pasku Zestawienia).
//
// DLACZEGO Z APPKI, A NIE Z REPOZYTORIUM: wtyczkę wgrywa się na komputer KAŻDEGO dyspozytora, a
// poprawki w niej (wybór pola na stronie terminala, klikanie przez CDP) wychodzą po każdym
// zderzeniu z żywym Baltic Hubem. Odsyłanie ludzi do repozytorium znaczyłoby, że część z nich
// zostaje na starej wersji i nikt tego nie widzi. Appka wie, jaka wersja jest w paczce, i pyta
// wtyczkę, jaką wersję ma zainstalowaną — rozjazd widać od razu.
//
// ZIP i `wersja.json` powstają przy każdym buildzie (`scripts/build-extension-zip.mjs`), więc
// paczka nie może się rozjechać z katalogiem `extension/` w repo.

export const KATALOG_PACZKI = "/rozszerzenie";
export const OPIS_PACZKI_URL = `${KATALOG_PACZKI}/wersja.json`;

export interface PaczkaWtyczki {
  wersja: string;
  nazwa: string;
  /** Nazwa pliku ZIP w `public/rozszerzenie/` — adres do pobrania jest STAŁY, niezależny od wersji. */
  plik: string;
  /** Pod tą nazwą przeglądarka zapisze pobrany plik (z numerem wersji). */
  nazwaPliku: string;
  /** Katalog wewnątrz ZIP-a — ten wskazuje się w „Załaduj rozpakowane". */
  katalogWZip: string;
  rozmiar: number;
  zbudowano: string;
  plikow: number;
}

export function adresPaczki(paczka: PaczkaWtyczki): string {
  return `${KATALOG_PACZKI}/${paczka.plik}`;
}

/**
 * Opis paczki wgranej razem z appką. Braku pliku NIE traktujemy jak awarii do ukrycia: gdy build
 * poszedł bez `scripts/build-extension-zip.mjs`, okno ma o tym powiedzieć wprost, zamiast oferować
 * guzik prowadzący donikąd.
 */
export async function pobierzOpisPaczki(): Promise<PaczkaWtyczki> {
  const res = await fetch(`${OPIS_PACZKI_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Nie znalazłem paczki z wtyczką (HTTP ${res.status}). Powstaje przy budowaniu appki — ` +
        "uruchom `npm run wtyczka` i wgraj appkę ponownie.",
    );
  }
  const dane = (await res.json()) as Partial<PaczkaWtyczki>;
  if (!dane?.wersja || !dane?.plik) throw new Error("Opis paczki z wtyczką jest uszkodzony (brak wersji albo nazwy pliku).");
  return {
    wersja: dane.wersja,
    nazwa: dane.nazwa ?? "Grabowski — statusy kontenerów",
    plik: dane.plik,
    nazwaPliku: dane.nazwaPliku ?? dane.plik,
    katalogWZip: dane.katalogWZip ?? "grabowski-statusy-kontenerow",
    rozmiar: dane.rozmiar ?? 0,
    zbudowano: dane.zbudowano ?? "",
    plikow: dane.plikow ?? 0,
  };
}

/** Porównanie wersji „1.0.10" vs „1.0.9" — po członach jako LICZBY (tekstowo „10" < „9"). */
export function porownajWersje(a: string, b: string): number {
  const rozbij = (v: string) => v.split(".").map((czesc) => Number.parseInt(czesc, 10) || 0);
  const x = rozbij(a);
  const y = rozbij(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const roznica = (x[i] ?? 0) - (y[i] ?? 0);
    if (roznica !== 0) return roznica < 0 ? -1 : 1;
  }
  return 0;
}

export type StanPaczki = "brak_wtyczki" | "stara" | "aktualna" | "nowsza" | "nieznana";

/**
 * Czy dyspozytor ma aktualną wtyczkę. `nowsza` (zainstalowana wyższa niż w paczce) nie jest
 * błędem — tak wygląda komputer programisty z katalogiem wgranym wprost z repo — ale ma się
 * różnić od „aktualna", żeby nikt nie brał starej appki za świeżą.
 */
export function stanPaczki(paczka: PaczkaWtyczki | null, zainstalowana: string | null): StanPaczki {
  if (!zainstalowana) return "brak_wtyczki";
  if (!paczka) return "nieznana";
  const cmp = porownajWersje(zainstalowana, paczka.wersja);
  return cmp < 0 ? "stara" : cmp > 0 ? "nowsza" : "aktualna";
}
