// Pakuje katalog `extension/` do pliku ZIP w `public/rozszerzenie/`, żeby dyspozytor mógł pobrać
// aktualną wtyczkę wprost z appki (guzik „Wtyczka" w pasku Zestawienia) — bez klonowania repo,
// bez pytania kogokolwiek o paczkę.
//
// DLACZEGO WŁASNY ZAPIS ZIP-a, a nie `zip`/biblioteka: appka jest eksportem statycznym wgrywanym
// na Netlify, więc paczka musi powstać PRZED buildem, na komputerze właściciela. Zewnętrzny `zip`
// nie istnieje na Windowsie, a doklejanie zależności npm po to, żeby skleić kilkanaście plików,
// kosztowałoby więcej, niż daje. Format ZIP-a to nagłówek + deflate (`zlib` jest w Node) + spis
// treści na końcu — całość poniżej.
//
// URUCHAMIANIE: samo idzie przez `predev`/`prebuild` w `package.json`. Ręcznie:
//   node scripts/build-extension-zip.mjs
// Wynik (`public/rozszerzenie/`) jest w `.gitignore` — to artefakt buildu, nie kod.

import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ZRODLO = join(ROOT, "extension");
const CEL = join(ROOT, "public", "rozszerzenie");
/** Stała nazwa pliku = stały adres do pobrania. Wersja idzie w nazwę, pod którą plik się ZAPISUJE
 *  (atrybut `download` w appce) — inaczej appka musiałaby znać adres zależny od wersji. */
const NAZWA_ZIP = "wtyczka.zip";
/** Katalog wewnątrz ZIP-a — Chrome („Załaduj rozpakowane") wskazuje się KATALOG z `manifest.json`.
 *  Nazwa jest stała, żeby aktualizacja była nadpisaniem tego samego katalogu i kliknięciem
 *  „Odśwież" w `chrome://extensions`, a nie wgrywaniem rozszerzenia od nowa. */
const KATALOG_W_ZIP = "grabowski-statusy-kontenerow";

// Pliki robocze, których w paczce być nie ma po co (i które psułyby wgrywanie do Chrome).
const POMIJANE = new Set([".DS_Store", "Thumbs.db"]);

// ---------------------------------------------------------------- CRC-32 (wymagany przez format)

const TABLICA_CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLICA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------- składanie ZIP-a

/** Data i godzina w formacie MS-DOS (dwa 16-bitowe pola) — tego wymaga nagłówek wpisu. */
function datyDos(date) {
  const rok = Math.max(1980, date.getFullYear());
  return {
    czas: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    data: ((rok - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip(wpisy) {
  const czesci = [];
  const spis = [];
  let offset = 0;

  for (const wpis of wpisy) {
    const nazwa = Buffer.from(wpis.nazwa, "utf8");
    const spakowane = deflateRawSync(wpis.dane, { level: 9 });
    // Deflate potrafi być WIĘKSZY od oryginału (drobne, już skompresowane pliki — np. PNG).
    // Wtedy zapisujemy bez kompresji: metoda 0.
    const uzyjDeflate = spakowane.length < wpis.dane.length;
    const tresc = uzyjDeflate ? spakowane : wpis.dane;
    const metoda = uzyjDeflate ? 8 : 0;
    const suma = crc32(wpis.dane);
    const { czas, data } = datyDos(wpis.data);

    const naglowek = Buffer.alloc(30);
    naglowek.writeUInt32LE(0x04034b50, 0);
    naglowek.writeUInt16LE(20, 4); // wymagana wersja
    naglowek.writeUInt16LE(0x0800, 6); // nazwy w UTF-8
    naglowek.writeUInt16LE(metoda, 8);
    naglowek.writeUInt16LE(czas, 10);
    naglowek.writeUInt16LE(data, 12);
    naglowek.writeUInt32LE(suma, 14);
    naglowek.writeUInt32LE(tresc.length, 18);
    naglowek.writeUInt32LE(wpis.dane.length, 22);
    naglowek.writeUInt16LE(nazwa.length, 26);
    naglowek.writeUInt16LE(0, 28); // brak pola dodatkowego

    czesci.push(naglowek, nazwa, tresc);

    const wpisSpisu = Buffer.alloc(46);
    wpisSpisu.writeUInt32LE(0x02014b50, 0);
    wpisSpisu.writeUInt16LE(20, 4); // wersja zapisującego
    wpisSpisu.writeUInt16LE(20, 6); // wymagana wersja
    wpisSpisu.writeUInt16LE(0x0800, 8);
    wpisSpisu.writeUInt16LE(metoda, 10);
    wpisSpisu.writeUInt16LE(czas, 12);
    wpisSpisu.writeUInt16LE(data, 14);
    wpisSpisu.writeUInt32LE(suma, 16);
    wpisSpisu.writeUInt32LE(tresc.length, 20);
    wpisSpisu.writeUInt32LE(wpis.dane.length, 24);
    wpisSpisu.writeUInt16LE(nazwa.length, 28);
    wpisSpisu.writeUInt32LE(offset, 42);
    spis.push(wpisSpisu, nazwa);

    offset += naglowek.length + nazwa.length + tresc.length;
  }

  const trescSpisu = Buffer.concat(spis);
  const koniec = Buffer.alloc(22);
  koniec.writeUInt32LE(0x06054b50, 0);
  koniec.writeUInt16LE(wpisy.length, 8);
  koniec.writeUInt16LE(wpisy.length, 10);
  koniec.writeUInt32LE(trescSpisu.length, 12);
  koniec.writeUInt32LE(offset, 16);

  return Buffer.concat([...czesci, trescSpisu, koniec]);
}

// ---------------------------------------------------------------- zbieranie plików

function pliki(katalog, prefiks = "") {
  const out = [];
  for (const wpis of readdirSync(katalog, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (POMIJANE.has(wpis.name)) continue;
    const sciezka = join(katalog, wpis.name);
    const wZip = prefiks ? `${prefiks}/${wpis.name}` : wpis.name;
    if (wpis.isDirectory()) out.push(...pliki(sciezka, wZip));
    else out.push({ sciezka, wZip });
  }
  return out;
}

const znalezione = pliki(ZRODLO);
const manifest = JSON.parse(readFileSync(join(ZRODLO, "manifest.json"), "utf8"));
if (!manifest.version) throw new Error("extension/manifest.json nie ma pola `version` — bez niego appka nie pozna, czy wtyczka jest aktualna.");

const wpisy = znalezione.map(({ sciezka, wZip }) => ({
  nazwa: `${KATALOG_W_ZIP}/${wZip}`,
  dane: readFileSync(sciezka),
  data: statSync(sciezka).mtime,
}));

mkdirSync(CEL, { recursive: true });
const paczka = zip(wpisy);
writeFileSync(join(CEL, NAZWA_ZIP), paczka);

// Appka czyta ten plik, żeby pokazać wersję do pobrania i porównać ją z zainstalowaną.
writeFileSync(
  join(CEL, "wersja.json"),
  `${JSON.stringify(
    {
      wersja: manifest.version,
      nazwa: manifest.name,
      plik: NAZWA_ZIP,
      // Nazwa, pod którą przeglądarka zapisze pobrany plik — z wersją, żeby w Pobranych było widać,
      // co jest czym.
      nazwaPliku: `grabowski-wtyczka-${manifest.version}.zip`,
      katalogWZip: KATALOG_W_ZIP,
      rozmiar: paczka.length,
      zbudowano: new Date().toISOString(),
      plikow: wpisy.length,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Wtyczka ${manifest.version}: ${wpisy.length} plików → ${relative(ROOT, join(CEL, NAZWA_ZIP))} (${Math.round(paczka.length / 1024)} kB)`,
);
