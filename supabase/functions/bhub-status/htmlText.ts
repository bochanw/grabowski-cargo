// ============================================================
// HTML z terminala → TEKST W TYM SAMYM KSZTAŁCIE, co przysyła rozszerzenie (`innerText`).
//
// PO CO TO ISTNIEJE — i dlaczego to nie jest „jeszcze jeden parser":
// BCT i GCT odpytujemy dziś DWIEMA drogami: z serwera (zwykły fetch, dostajemy HTML) i z
// przeglądarki dyspozytora przez rozszerzenie (dostajemy widoczny tekst). Gdyby każda droga
// miała własny odczyt, pierwsza poprawka rozjechałaby je na trwałe — a `parse.ts` ma już
// fixtury, testy i wiedzę o tym, co znaczy „--", pusta rubryka i stary zapis kodu ISO.
// Dlatego transport normalizujemy TUTAJ, a `parse.ts` zostaje JEDEN i nie wie, skąd przyszedł
// tekst.
//
// Naśladujemy `innerText`, nie „strip tags":
//   * komórki tabeli rozdziela TABULATOR — w GCT tylko on mówi, gdzie kończy się „Status",
//     a zaczyna „Status celny" (obie wartości to wolny tekst ze spacjami),
//   * wiersz tabeli kończy ZŁAMANIE LINII,
//   * `&nbsp;` ZOSTAJE znakiem U+00A0. To nie jest kosmetyka: pustą komórkę GCT zapisuje
//     właśnie tak, a `parse.ts` dzieli wiersz na pola po tabulatorach. Gdyby pusta komórka
//     zniknęła razem ze swoim tabulatorem, ostatnia kolumna wiersza skleiłaby się z pierwszą
//     kolumną NASTĘPNEGO wiersza — zmierzone: „Data/Czas podjęcia" wychodziło wtedy „2"
//     (numer porządkowy kolejnego kontenera), czyli appka twierdziłaby, że kontener został
//     podjęty. To ta sama rodzina pułapek co U+00A0 w `toLocaleString("pl-PL")`.
// ============================================================

/** Zamknięcie tych znaczników zaczyna nową linię (tabela i wiersz mają własne reguły niżej). */
const BLOKOWE = new Set([
  "p", "div", "li", "ul", "ol", "table", "thead", "tbody", "tfoot", "section", "article",
  "header", "footer", "form", "fieldset", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote",
]);

const ENCJE: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Dekoduje encje. `&nbsp;` ŚWIADOMIE zostaje U+00A0 — patrz nagłówek pliku. */
function odkoduj(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (całość, nazwa: string) => {
    if (nazwa.startsWith("#x") || nazwa.startsWith("#X")) {
      const kod = Number.parseInt(nazwa.slice(2), 16);
      return Number.isFinite(kod) ? String.fromCodePoint(kod) : całość;
    }
    if (nazwa.startsWith("#")) {
      const kod = Number.parseInt(nazwa.slice(1), 10);
      return Number.isFinite(kod) ? String.fromCodePoint(kod) : całość;
    }
    return ENCJE[nazwa.toLowerCase()] ?? całość;
  });
}

/**
 * Tekst między znacznikami. Białe znaki ZE ŹRÓDŁA (wcięcia, złamania linii w kodzie HTML) nie
 * niosą znaczenia i schodzą do jednej spacji — inaczej tabulator wcięcia udawałby granicę
 * kolumny. Twarda spacja NIE jest białym znakiem w tym sensie i zostaje nietknięta.
 */
function tekstWezla(fragment: string): string {
  return odkoduj(fragment).replace(/[ \t\r\n\f]+/g, " ");
}

/**
 * HTML → tekst. Wynik ma być nieodróżnialny od tego, co rozszerzenie czyta z ekranu:
 * ten sam podział na linie, te same tabulatory między komórkami.
 */
export function htmlToText(html: string): string {
  const oczyszczony = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ");

  let out = "";
  let i = 0;
  while (i < oczyszczony.length) {
    const otwarcie = oczyszczony.indexOf("<", i);
    if (otwarcie < 0) {
      out += tekstWezla(oczyszczony.slice(i));
      break;
    }
    out += tekstWezla(oczyszczony.slice(i, otwarcie));

    const zamkniecie = oczyszczony.indexOf(">", otwarcie);
    if (zamkniecie < 0) break;

    const znacznik = oczyszczony.slice(otwarcie + 1, zamkniecie);
    const nazwa = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(znacznik)?.[1]?.toLowerCase() ?? "";
    const zamykajacy = znacznik.trimStart().startsWith("/");

    if (nazwa === "br") {
      out += "\n";
    } else if (zamykajacy && (nazwa === "td" || nazwa === "th")) {
      // Każda komórka kończy się tabulatorem; nadmiarowy (po OSTATNIEJ komórce) zdejmuje `</tr>`.
      out += "\t";
    } else if (zamykajacy && nazwa === "tr") {
      // Tabulator po OSTATNIEJ komórce wiersza. Wzorzec dopuszcza spacje za nim, bo między
      // `</td>` a `</tr>` w źródle zwykle stoi wcięcie — bez tego wiersz miałby o jedną
      // kolumnę więcej niż ta sama tabela odczytana z ekranu przez rozszerzenie.
      out = out.replace(/\t[ ]*$/, "");
      out += "\n";
    } else if (zamykajacy && BLOKOWE.has(nazwa)) {
      out += "\n";
    }

    i = zamkniecie + 1;
  }

  // Sprzątanie linii: przycinamy WYŁĄCZNIE spacje. Tabulator na brzegu linii to pusta pierwsza
  // albo ostatnia komórka — przycięcie go przesunęłoby wszystkie kolumny wiersza o jedną.
  const linie = out.split("\n").map((l) => l.replace(/^ +| +$/g, ""));
  return linie.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
