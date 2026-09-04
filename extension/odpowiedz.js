// Kiedy odpowiedź terminala JEST już odpowiedzią na nasze pytanie.
//
// Osobny plik, bo to jedyna reguła w rozszerzeniu, którą da się (i trzeba) sprawdzić bez
// przeglądarki — a kosztowała trzy nieudane przebiegi u właściciela.
//
// Dwa stany kończą wyszukiwanie i tylko one:
//   1. karta kontenera Z NASZYM numerem,
//   2. jawne „Brak wyników dla: <numer>" — też z NASZYM numerem.
//
// Wszystko inne znaczy „jeszcze nie" albo „zapytanie poszło w próżnię":
//   - zaraz po kliknięciu strona pokazuje PUSTĄ sekcję „Brak wyników:", a kartę dorzuca chwilę
//     później. Migawka zabrana w tym momencie zapisywała przy zleceniu „Baltic Hub nie zna
//     kontenera", choć dane były na ekranie;
//   - gdy zapytanie dojdzie puste (reCAPTCHA nie zdążyła się uruchomić), terminal odpowiada
//     dokładnie tak samo — samym „Brak wyników:" bez numeru.
//
// DLACZEGO SAMO „Karta kontenera" JUŻ NIE WYSTARCZA (zgłoszenie właściciela: pojedynczy kontener
// czyta się bez pudła, a przy kilku „program się gubi"): przy sprawdzaniu kilku zleceń pytamy po
// jednym, w TEJ SAMEJ karcie przeglądarki. Gdy nawigacja na świeżą stronę jeszcze się nie
// dokonała, w treści wisi KARTA POPRZEDNIEGO kontenera — i warunek „widać jakąkolwiek kartę"
// uznawał ją za odpowiedź na nowe pytanie. Do serwera szedł wtedy tekst o cudzym kontenerze,
// `parse.ts` nie znajdował w nim naszego numeru i przy zleceniu lądowało „nie rozpoznałem
// odpowiedzi". Pierwszy kontener zawsze wychodził dobrze, bo przed nim żadnej karty nie było.
//
// Warunek jest teraz DOKŁADNIE tym, czego wymaga `parse.ts` po stronie serwera: bez naszego numeru
// w treści nie da się z niej i tak nic odczytać (`wytnijKarte` szuka „Unit Nbr: <numer>"), więc
// czekanie dalej nic nie kosztuje, a zabiera migawkę we właściwym momencie.
export function odpowiedzDotyczyNas(tekst, numery) {
  return (numery || []).some((n) => wzorzecNumeru(n).test(tekst || ""));
}

/**
 * Numer kontenera tak, jak MOŻE stać na stronie: terminal rozdziela litery od cyfr spacją
 * („OMTU 2301120"), a `innerText` potrafi dołożyć swoje. Dopuszczamy odstęp między każdą parą
 * znaków — przy jedenastoznakowym kodzie przypadkowe trafienie jest niemożliwe.
 *
 * Wartość wpisana w pole formularza NIE liczy się jako odpowiedź: `innerText` nie zawiera `value`
 * pól, więc numer widzimy dopiero wtedy, gdy strona sama go wypisze.
 */
function wzorzecNumeru(numer) {
  const znaki = String(numer)
    .replace(/\s+/g, "")
    .split("")
    .map((z) => z.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(znaki.join("\\s*"), "i");
}
