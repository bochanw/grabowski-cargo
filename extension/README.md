# Rozszerzenie „Grabowski — statusy kontenerów"

Sprawdza w Baltic Hubie, BCT i GCT statusy kontenerów, które stamtąd podejmujemy, i zapisuje je przy
zleceniach w appce. Działa w przeglądarce dyspozytora, bo terminal odrzuca ruch z serwerowni:
`baltichub.com` stoi za Cloudflare, a formularz ma reCAPTCHĘ. Prawdziwa przeglądarka na zwykłym
łączu przechodzi to sama.

## Instalacja (5 minut, raz na komputer)

1. W appce kliknij **Wtyczka** w pasku Zestawienia i pobierz paczkę, a potem rozpakuj ją w stałe
   miejsce (np. Dokumenty) — powstanie katalog `grabowski-statusy-kontenerow`. Chrome wczytuje
   wtyczkę z dysku przy każdym uruchomieniu, więc tego katalogu nie kasuj.
2. W Chrome otwórz `chrome://extensions`.
3. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu).
4. Kliknij **Załaduj rozpakowane** i wskaż rozpakowany katalog.
5. Kliknij ikonę rozszerzenia (kontener) na pasku Chrome i zaloguj się **tym samym e-mailem
   i hasłem, co w appce**. Logowanie jest jednorazowe — sesja odnawia się sama.

Rozszerzenie ma stały identyfikator (`jaiopbejoakjdggjpkgoambeifcjjffj`), więc appka rozpozna je
na każdym komputerze i po każdym ponownym wgraniu.

## Aktualizacja (1 minuta)

Guzik **Wtyczka** w appce świeci na pomarańczowo (`Wtyczka ●`), gdy w tej przeglądarce działa
starsza wersja niż ta wgrana z appką. Wtedy: pobierz paczkę, rozpakuj ją NA TEN SAM katalog co
poprzednio (nadpisz pliki) i w `chrome://extensions` kliknij strzałkę **Odśwież** na kafelku
wtyczki. Logowanie zostaje — nie trzeba go powtarzać.

## Jak to działa

- Co 15 minut (oraz po kliknięciu „Statusy BHub" w appce i po zapisaniu zlecenia z podjęciem
  z BHub) rozszerzenie pyta appkę, o które kontenery chodzi.
- Otwiera **przypiętą kartę** ze stroną terminala, wpisuje numery (po dziesięć naraz), klika
  „Sprawdź" i odsyła widoczny tekst wyników do appki. Karta jest nieaktywna — nie zabiera
  dyspozytorowi tego, na co patrzy.
- Odczyt rozumie i zapisuje serwer (funkcja `bhub-status`), nie rozszerzenie. Dzięki temu poprawka
  w regułach odczytu nie wymaga aktualizacji rozszerzenia na każdym komputerze.
- Wynik trafia do bazy i przez Realtime do WSZYSTKICH otwartych Zestawień — także tych, które
  same nie mają rozszerzenia.

Poza oknem odpytywania (dni robocze 6:00-18:00 czasu polskiego) cykliczne sprawdzanie nie rusza.
Ręczna prośba z appki działa zawsze — człowiek, który pyta, ma dostać odpowiedź.

## Ilu pracowników musi je mieć

**Wystarczy JEDEN włączony komputer z Chrome** — wynik jest wspólny dla wszystkich. Sensowny
układ:

- zainstalować na 2-3 komputerach (zapas na urlop, awarię, wyłączony komputer),
- jeden traktować jako główny: Chrome uruchomiony przez czas pracy biura, komputer bez usypiania.

Kilka włączonych naraz sobie nie przeszkadza: kontener sprawdzony w ciągu ostatnich 10 minut nie
wraca na listę, więc drugie rozszerzenie nie pyta terminala o to samo.

Gdy nikt nie ma włączonej przeglądarki, statusy po prostu się nie odświeżają — i **widać to
w pasku Zestawienia** („statusy: cisza od …" na pomarańczowo). Cichego zastoju nie ma.

## Gdy terminal poprosi o potwierdzenie

Cloudflare albo reCAPTCHA potrafią raz na jakiś czas wyskoczyć z pytaniem, którego żaden automat
nie kliknie. Wtedy rozszerzenie pokazuje powiadomienie „Baltic Hub czeka na Ciebie" — kliknięcie
otwiera przypiętą kartę, wystarczy przejść weryfikację ręcznie. Kolejne sprawdzenia pójdą już same
(przeglądarka zapamiętuje ciasteczko).

## Okno rozszerzenia

- **Sprawdź teraz** — przebieg poza kolejnością.
- **Otwórz stronę terminala** — przypięta karta, gdy trzeba coś kliknąć ręcznie.
- **Adresy stron terminali** (osobno BHub, BCT, GCT) — do zmiany, gdyby terminal przeniósł stronę (albo przy kolejnym
  terminalu).
- **Nazwa tego komputera** — pokazuje się w appce przy stanie sprawdzania („Dyspozytornia 1").

## Co robić przy kłopotach

| Objaw | Powód i co zrobić |
| --- | --- |
| W appce „Nie widzę rozszerzenia…" | Nie jest zainstalowane w TEJ przeglądarce albo wyłączone. Sprawdź `chrome://extensions`. |
| „Rozszerzenie nie jest zalogowane" | Otwórz okno rozszerzenia i zaloguj się kontem z appki. |
| „…nie przeszła weryfikacji Cloudflare" | Otwórz przypiętą kartę i przejdź weryfikację ręcznie. |
| „Baltic Hub poprosił o rozwiązanie zagadki" | To samo — kliknij zagadkę w przypiętej karcie. |
| „statusy: cisza od X godzin" | Żaden komputer z rozszerzeniem nie działał. Włącz Chrome na komputerze głównym. |

## Dla programisty

Katalog jest gotowym rozszerzeniem — **bez budowania, bez zależności**. Paczkę ZIP do pobrania
z appki robi z niego `scripts/build-extension-zip.mjs` (jedzie w `prebuild`/`predev`, ręcznie:
`npm run wtyczka`) — **po zmianie w rozszerzeniu podnieś `version` w `manifest.json`**, inaczej
appka nie pozna, że dyspozytorzy mają starą wersję. Pliki:

- `manifest.json` — uprawnienia, stały klucz (identyfikator), adresy, spod których appka może
  wysłać prośbę o sprawdzenie (`externally_connectable`).
- `background.js` — cały przebieg: kolejka z serwera → karta → wpisanie → odczyt → odesłanie.
- `page.js` — jedyny plik dotykający cudzego HTML-a; przy kolejnym terminalu zmienia się tylko on.
- `odpowiedz.js` — kiedy to, co widać na stronie, JEST już odpowiedzią na nasz numer.
- `api.js`, `config.js` — logowanie do Supabase i ustawienia.

**TRZY TERMINALE** (od 1.1.0): Baltic Hub, BCT i GCT. O tym, gdzie pytać o dany kontener, decyduje
pole „Podjęcie" zlecenia — serwer przysyła nazwę terminala razem z numerem, więc czwarty terminal
będzie zmianą po stronie appki, a nie na komputerze dyspozytora. W `config.js` zostaje tylko to,
czego serwer wiedzieć nie może: adres formularza, rozmiar paczki, znak rozdzielający numery i ślad,
po którym poznać gotową odpowiedź (`markerWynikow` — u GCT sam numer NIE wystarcza, bo siedzi
w polu tekstowym).

Przy sprawdzaniu kilku kontenerów pytamy po jednym, w tej samej karcie — dlatego trzy rzeczy są
tu krytyczne i mają własne testy:

1. rozszerzenie czeka na ŚWIEŻY dokument (nie na sam adres, bo stara strona ma ten sam),
2. uznaje za odpowiedź tylko treść z NASZYM numerem (nie „jakąkolwiek kartę kontenera", bo na
   ekranie wisi jeszcze karta poprzedniego),
3. po wpisaniu SPRAWDZA, co naprawdę stoi w polu (`stanPola`), i dopiero wtedy klika „Sprawdź".
   Gdy zaufany klik nie trafi w pole — próbuje jeszcze raz, ustawiając kursor przez `focus()`.
   Bez tego pustego zapytania nie da się odróżnić od „terminal nie zna kontenera".
- `popup.html` / `popup.js` — okno rozszerzenia.

Testy (w środowisku z Playwrightem): `page.js` sprawdzany na stronie odwzorowującej mierzone
pułapki terminala, całe rozszerzenie — wgrane do prawdziwego Chrome (manifest, identyfikator,
wiadomości, alarm). Szczegóły w `CLAUDE.md`, sekcja o Baltic Hubie.

**BRAMKA SKŁADNI przy pakowaniu.** `scripts/build-extension-zip.mjs` parsuje KAŻDY plik `.js`
wtyczki jako moduł i przerywa pakowanie, gdy któryś ma błąd składni. Powód jest konkretny: wersja
1.1.0 wyszła z niedomkniętym napisem w `background.js` (zwykły cudzysłów w środku polskiego
cytatu), przez co service worker w ogóle się nie ładował — a objawem było PUSTE okno wtyczki, bo
nie miał kto odpowiedzieć na wiadomość. Wtyczka nie ma buildu, więc nic tego nie łapało.
