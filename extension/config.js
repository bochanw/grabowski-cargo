// Ustawienia rozszerzenia. Adres i klucz są PUBLICZNE (ten sam klucz publishable co w appce —
// nigdy `service_role`), więc mogą leżeć w repo i w rozpakowanym rozszerzeniu.
//
// Wszystko, co może się zmienić bez nowej wersji rozszerzenia (adres strony terminala, częstość,
// wielkość paczki), da się nadpisać w oknie rozszerzenia i siedzi w `chrome.storage.local`.

export const DOMYSLNE = {
  supabaseUrl: "https://itlgexjhznjsbonzdxyg.supabase.co",
  anonKey: "sb_publishable_iZKZO54CEMneO3wyWStPPA_nnb0V8J0",
  // Strona sprawdzania kontenerów. Numery wysyła JavaScript tej strony, nie formularz — dlatego
  // wchodzimy TUTAJ i klikamy, zamiast składać własne zapytanie na /multi (to wraca "Page Expired").
  adresTerminala: "https://baltichub.com/dla-klienta/sprawdz-kontener",
  // PYTAMY PO JEDNYM KONTENERZE — zmierzone, nie założone.
  //
  // Terminal ma tryb „Wyszukaj więcej kontenerów" (do dziesięciu po przecinku), ale sam opisuje go
  // jako WERSJĘ TESTOWĄ i na produkcji oddał „Brak wyników" dla pięciu numerów naraz — podczas gdy
  // ten sam numer wpisany pojedynczo pokazał pełną kartę kontenera (sprawdzone ręcznie przez
  // właściciela: MBUU1000292, T-State Yard, Weight 23976.0).
  //
  // Przy odpytywaniu z serwerowni paczka miała sens (jedno pobranie ~25 s i tyle samo kosztowało).
  // W przeglądarce dyspozytora jedno zapytanie to kilkanaście sekund i nic nie kosztuje, więc
  // pewny wynik jest wart tego czasu. Tryb „wiele" zostaje obsłużony w kodzie — wystarczy wpisać
  // większą liczbę w oknie rozszerzenia, gdyby terminal kiedyś doprowadził go do porządku.
  rozmiarPaczki: 1,
  coIleMinut: 15,
};

export async function ustawienia() {
  const zapisane = await chrome.storage.local.get(["adresTerminala", "rozmiarPaczki", "coIleMinut", "etykieta"]);
  return { ...DOMYSLNE, ...Object.fromEntries(Object.entries(zapisane).filter(([, v]) => v !== undefined && v !== "")) };
}
