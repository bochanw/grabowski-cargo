// Kiedy odpowiedź terminala JEST już odpowiedzią na nasze pytanie.
//
// Osobny plik, bo to jedyna reguła w rozszerzeniu, którą da się (i trzeba) sprawdzić bez
// przeglądarki — a kosztowała dwa nieudane przebiegi u właściciela.
//
// Dwa stany kończą wyszukiwanie i tylko one:
//   1. karta kontenera na stronie,
//   2. jawne „Brak wyników dla: <numer>" — z NASZYM numerem.
//
// Wszystko inne znaczy „jeszcze nie" albo „zapytanie poszło w próżnię":
//   - zaraz po kliknięciu strona pokazuje PUSTĄ sekcję „Brak wyników:", a kartę dorzuca chwilę
//     później. Migawka zabrana w tym momencie zapisywała przy zleceniu „Baltic Hub nie zna
//     kontenera", choć dane były na ekranie;
//   - gdy zapytanie dojdzie puste (reCAPTCHA nie zdążyła się uruchomić), terminal odpowiada
//     dokładnie tak samo — samym „Brak wyników:" bez numeru.
// Jedno i drugie rozróżnia obecność naszego numeru w treści.
export function odpowiedzDotyczyNas(tekst, numery) {
  if (/Karta kontenera/i.test(tekst)) return true;
  const duze = (tekst || "").toUpperCase();
  return (numery || []).some((n) => duze.includes(String(n).toUpperCase()));
}
