// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/lib/driverRates/postalFromText.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

// Kod pocztowy WYCIĄGANY Z TEKSTU DOKUMENTU, gdy odczyt (model albo szablon) oddał sam adres bez
// kodu — a to jest przypadek większości zleceń: na 115 dokumentów odczytanych przez Claude PRZED
// dodaniem pola `postal_code` tylko 11 miało kod w polu adresu, choć w samych dokumentach stoi
// prawie zawsze. Model po prostu nie był o niego pytany.
//
// Dlaczego to NIE jest zgadywanie: nie szukamy „jakiegoś kodu w dokumencie" (byłby nim równie
// dobrze kod spedytora z nagłówka albo agencji celnej), tylko kodu STOJĄCEGO PRZY MIEJSCOWOŚCI,
// którą już znamy z odczytu. Gdy przy tej miejscowości stoją w dokumencie dwa różne kody, nie
// wybieramy żadnego — od stawki dla kierowcy zależy wypłata, a zły kod to zła kwota.

const PL_MAP: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z",
};

/**
 * Normalizacja ZACHOWUJĄCA DŁUGOŚĆ (jeden znak → jeden znak): pozycje w tekście znormalizowanym
 * muszą odpowiadać pozycjom w oryginale, bo po znalezieniu miejscowości sięgamy do sąsiedztwa.
 * Dlatego nie używamy `normalizeSearchText` z wyszukiwarki — ta skleja białe znaki.
 */
function normalizeKeepingLength(text: string): string {
  return text.toLowerCase().replace(/[ąćęłńóśźż]/g, (ch) => PL_MAP[ch] ?? ch);
}

const KOD = /\d{2}-\d{3}/;
// Ile znaków przed nazwą miejscowości ma sens przeszukiwać. Typowy zapis ("05-500 Piaseczno") mieści
// się w kilku, ale w danych klienta trafia się też układ rubrykowy: kod kończy linię adresu, a miasto
// stoi w NASTĘPNEJ linii pod własną etykietą ("RYDZYNSKA 24F 64-125\nMiejscowość: PONIEC"). Stąd 40
// znaków ORAZ warunek niżej: między kodem a nazwą miasta wolno przeskoczyć najwyżej jedną linię —
// inaczej „przy miejscowości" przestałoby cokolwiek znaczyć i złapalibyśmy kod z innej rubryki.
const OKNO_PRZED = 40;
const MAKS_PRZERWA_LINII = 1;
const OKNO_PO = 20;

/**
 * Kod pocztowy stojący przy podanej miejscowości w tekście dokumentu.
 * Zwraca null, gdy miejscowości nie ma w tekście, gdy przy niej nie stoi żaden kod, albo gdy stoją
 * przy niej RÓŻNE kody (dokument wymienia to miasto kilka razy — wtedy nie zgadujemy).
 */
export function postalCodeNearCity(text: string, city: string | null | undefined): string | null {
  const miasto = normalizeKeepingLength((city ?? "").trim());
  // Krótka nazwa ("Wda", "Rus") trafiałaby w środek innych słów; dwa znaki to już przypadek.
  if (miasto.length < 3 || !text) return null;
  const haystack = normalizeKeepingLength(text);

  const znalezione = new Set<string>();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(miasto, from);
    if (at === -1) break;
    from = at + miasto.length;

    // Nazwa musi stać jako całe słowo — inaczej "Ujazd" trafiłoby w "Ujazdowska".
    const przed = haystack[at - 1];
    const po = haystack[at + miasto.length];
    const granicaZ = przed === undefined || /[^a-z0-9]/.test(przed);
    const granicaDo = po === undefined || /[^a-z0-9]/.test(po);
    if (!granicaZ || !granicaDo) continue;

    // Typowy zapis polski: kod PRZED miastem ("05-500 Piaseczno"). Bierzemy ostatni kod z okna,
    // czyli ten najbliższy nazwie.
    const lewo = text.slice(Math.max(0, at - OKNO_PRZED), at);
    const przedKod = [...lewo.matchAll(/\d{2}-\d{3}/g)].pop();
    const miedzy = przedKod ? lewo.slice(przedKod.index + przedKod[0].length) : "";
    if (przedKod && (miedzy.match(/\n/g)?.length ?? 0) <= MAKS_PRZERWA_LINII) znalezione.add(przedKod[0]);
    else {
      // Rzadziej: kod PO miejscowości ("Piaseczno 05-500", "Poniec, 64-125").
      const prawo = text.slice(at + miasto.length, at + miasto.length + OKNO_PO);
      const poKod = prawo.match(KOD);
      if (poKod) znalezione.add(poKod[0]);
    }
  }

  if (znalezione.size !== 1) return null;
  return [...znalezione][0];
}
