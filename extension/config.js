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
  // Terminal przyjmuje wiele numerów naraz (w wersji testowej do dziesięciu). Jedno wejście na
  // stronę trwa kilkanaście sekund, więc pytanie po jednym byłoby dziesięć razy dłuższe.
  rozmiarPaczki: 10,
  coIleMinut: 15,
};

export async function ustawienia() {
  const zapisane = await chrome.storage.local.get(["adresTerminala", "rozmiarPaczki", "coIleMinut", "etykieta"]);
  return { ...DOMYSLNE, ...Object.fromEntries(Object.entries(zapisane).filter(([, v]) => v !== undefined && v !== "")) };
}
