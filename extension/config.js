// Ustawienia rozszerzenia. Adres i klucz są PUBLICZNE (ten sam klucz publishable co w appce —
// nigdy `service_role`), więc mogą leżeć w repo i w rozpakowanym rozszerzeniu.
//
// Wszystko, co może się zmienić bez nowej wersji rozszerzenia (adresy terminali, częstość,
// wielkość paczki), da się nadpisać w oknie rozszerzenia i siedzi w `chrome.storage.local`.

export const DOMYSLNE = {
  supabaseUrl: "https://itlgexjhznjsbonzdxyg.supabase.co",
  anonKey: "sb_publishable_iZKZO54CEMneO3wyWStPPA_nnb0V8J0",
  coIleMinut: 15,
};

/**
 * TRZY TERMINALE. O tym, gdzie pytać o dany kontener, decyduje pole „Podjęcie" zlecenia — serwer
 * przysyła nazwę terminala razem z numerem, więc dołożenie czwartego to zmiana po stronie appki,
 * a nie na komputerze każdego dyspozytora. Tutaj zostaje tylko to, czego serwer wiedzieć nie może:
 * pod jakim adresem stoi formularz i po czym poznać, że odpowiedź już jest na ekranie.
 *
 * `markerWynikow` MUSI być czymś, czego na pustej stronie NIE MA:
 *   BHub, BCT — „Karta kontenera" pojawia się dopiero z odpowiedzią,
 *   GCT       — „Rozmiar ISO" to nagłówek tabeli wyników. Uwaga: sam „Nr kontenera" NIE nadaje się
 *               na marker, bo pusta strona GCT ma podpis pola „Nr kontenerów :", a wpisany przez
 *               nas numer i tak siedzi w polu tekstowym.
 */
export const TERMINALE = {
  BHub: {
    adres: "https://baltichub.com/dla-klienta/sprawdz-kontener",
    // PYTAMY PO JEDNYM KONTENERZE — zmierzone, nie założone. Terminal ma tryb „Wyszukaj więcej
    // kontenerów", ale sam opisuje go jako WERSJĘ TESTOWĄ i na produkcji oddał „Brak wyników" dla
    // pięciu numerów naraz, podczas gdy ten sam numer pojedynczo pokazał pełną kartę.
    rozmiarPaczki: 1,
    rozdzielnik: ", ",
    markerWynikow: "Karta kontenera|Brak wynik",
  },
  BCT: {
    adres: "https://ebrama.bct.ictsi.com/vbs-check-container",
    // Formularz przyjmuje wiele numerów po przecinku, ale sprawdzone mamy tylko pojedyncze
    // pytanie — paczkę zwiększymy, kiedy zobaczymy odpowiedź terminala na kilka numerów naraz.
    rozmiarPaczki: 1,
    rozdzielnik: ", ",
    markerWynikow: "Karta kontenera|Brak wynik",
  },
  GCT: {
    adres: "https://terminal.gct.pl/?page=90039_PublicCntrStatus.Report90039Page",
    // GCT wprost zaprasza do pytania zbiorczego („można podać więcej niż jeden nr kontenera,
    // oddzielonych spacjami, max. 242 znaki") i oddaje wiersz na kontener — dziesięć numerów mieści
    // się w limicie z zapasem.
    rozmiarPaczki: 10,
    rozdzielnik: " ",
    markerWynikow: "Rozmiar ISO",
  },
};

/** Adres terminala z nadpisaniem z ustawień (klucze `adresBHub`, `adresBCT`, `adresGCT`). */
export function konfiguracjaTerminala(nazwa, zapisane = {}) {
  const baza = TERMINALE[nazwa];
  if (!baza) return null;
  const nadpisany = zapisane[`adres${nazwa}`];
  return { nazwa, ...baza, adres: nadpisany && nadpisany.trim() ? nadpisany.trim() : baza.adres };
}

export async function ustawienia() {
  const zapisane = await chrome.storage.local.get([
    "coIleMinut",
    "etykieta",
    "adresBHub",
    "adresBCT",
    "adresGCT",
    "rozmiarPaczki",
  ]);
  const czyste = Object.fromEntries(Object.entries(zapisane).filter(([, v]) => v !== undefined && v !== ""));
  return { ...DOMYSLNE, ...czyste, zapisane: czyste };
}
