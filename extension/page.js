// ============================================================
// page.js — kod działający NA STRONIE TERMINALA. Wstrzykiwany przez rozszerzenie
// (`chrome.scripting.executeScript`) do karty z Baltic Hubem.
//
// Każda reguła niżej jest ZMIERZONA na prawdziwej stronie, nie założona — komentarze mówią, co
// dokładnie poszło nie tak, zanim powstała. To jedyny plik, który dotyka cudzego HTML-a, więc
// przy kolejnym terminalu (albo po przebudowie tej strony) zmienia się tylko on.
//
// UWAGA: wcześniej ten sam kod był SZABLONEM TEKSTOWYM w funkcji brzegowej i `\s` znaczyło w nim
// samo "s" — wzorce wymagały podwójnych ukośników, a jeden pojedynczy kosztował cały przebieg
// (`replace(/\s+/g,' ')` zaczynał wycinać ze strony litery "s"). Tutaj to zwykły JavaScript,
// więc ta pułapka po prostu nie istnieje. NIE wracać do sklejania tego kodu z tekstu.
//
// Plik jest idempotentny i nie ma `export` — dzięki temu wchodzi zarówno przez `executeScript`,
// jak i przez `<script src>` na stronie testowej, czyli testujemy DOKŁADNIE ten kod, który biegnie
// u dyspozytora.
// ============================================================

(() => {
  if (globalThis.__bhub) return;

  const napis = (el) => ((el && (el.textContent || el.value)) || "").replace(/\s+/g, " ").trim();

  /**
   * Czy element siedzi w oknie zgody na ciasteczka albo innym oknie nakładkowym.
   *
   * ZMIERZONE NA PRODUKCJI (pierwsze uruchomienie u właściciela): baltichub.com używa CookieYes,
   * którego bannerek ma guziki „Dostosuj | Odrzuć wszystkie | Akceptuj wszystko", a „Dostosuj"
   * jest zwykłym BUTTON[type=submit]. Szukanie guzika „pierwszy submit na stronie" trafiło
   * właśnie w niego: numery zostały wpisane, po czym otworzył się panel ustawień ciasteczek,
   * a appka czekała 60 s na wyniki, których nikt nie zamówił.
   *
   * Dlatego cała maszyneria zgody jest teraz WYKLUCZONA z szukania pola i guzika — zamykamy ją,
   * ale nigdy nie traktujemy jej przycisków jako formularza terminala.
   */
  function wOknieZgody(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const id = n.id || "";
      const klasa = typeof n.className === "string" ? n.className : "";
      if (/cky|cookie|consent|gdpr|rodo/i.test(`${id} ${klasa}`)) return true;
      if (n.getAttribute && n.getAttribute("role") === "dialog") return true;
    }
    return false;
  }

  const widocznePola = () =>
    [...document.querySelectorAll("input, textarea")].filter(
      (el) => el.type !== "hidden" && el.offsetParent !== null && !wOknieZgody(el),
    );

  const opisPola = (el) =>
    !el
      ? "(brak)"
      : `${el.tagName}[${el.type || ""}] name=${el.name || "-"} id=${el.id || "-"} ` +
        `podpowiedz=${el.placeholder || "-"} formularz=${(el.form && el.form.getAttribute("action")) || "-"}`;

  const opisGuzika = (b) => (!b ? "(brak)" : `${b.tagName}[${b.type || ""}] „${napis(b).slice(0, 40)}”`);

  /**
   * Pole na numery kontenerów. Wykluczenia są tu WAŻNIEJSZE niż dopasowania — zmierzone:
   *  - typy nietekstowe: pierwsza wersja wpisała numery w PRZYCISK RADIOWY `name=seacontainer`;
   *  - pola wyszukiwarki serwisu: jedyne formularze na tej stronie to dwa razy `GET /search`,
   *    a formularza wysyłającego na `/multi` NIE MA W OGÓLE — numery wysyła JavaScript strony.
   */
  const TYPY_TEKSTOWE = ["text", "search", "tel", "url", "email", ""];
  function polaTekstowe() {
    return widocznePola().filter(
      (el) => el.tagName === "TEXTAREA" || TYPY_TEKSTOWE.includes((el.type || "text").toLowerCase()),
    );
  }

  function znajdzPole() {
    const opis = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""}`;
    const szukajkaSerwisu = (el) =>
      /search|szukaj/i.test(`${(el.form && el.form.getAttribute("action")) || ""} ${opis(el)}`);

    const kandydaci = polaTekstowe();
    const poza = kandydaci.filter((el) => !szukajkaSerwisu(el));
    return (
      poza.find((el) => /kontener|container|unit|numer/i.test(opis(el))) ||
      poza.find((el) => el.tagName === "TEXTAREA") ||
      poza[0] ||
      kandydaci.find((el) => /kontener|container|unit/i.test(opis(el))) ||
      null
    );
  }

  /**
   * Guzik uruchamiający wyszukiwanie. Formularza na `/multi` nie ma, więc nie ma się czym
   * ograniczyć — rozstrzyga KRÓTKI, dokładny napis. W nawigacji strony stoi „Sprawdź kontener
   * online" (długie), a nagłówki tabeli wyników to „Unit Number", „ISO Type"; jedno i drugie
   * łapało się na luźne dopasowanie i klik nie robił nic.
   */
  /** Napisy, w które NIGDY nie wolno kliknąć jako w „guzik wyszukiwania". */
  const ZAKAZANE = /dostosuj|odrzu|zapisz moje|poka\S* wi\S*|ustawienia|preferenc|customize|manage|reject|settings|online/i;

  /**
   * Guzik uruchamiający wyszukiwanie — szukany OD POLA, nie od strony.
   *
   * Kolejność (od najpewniejszej): guzik w tym samym formularzu co pole, potem w kolejnych
   * pojemnikach nadrzędnych pola (najbliższy wygrywa), na końcu cała strona po dokładnym napisie.
   * Zawsze z pominięciem okna zgody i napisów z listy ZAKAZANE.
   *
   * Powód takiej kolejności jest zmierzony: na tej stronie formularza na `/multi` NIE MA (numery
   * wysyła JavaScript), w nawigacji stoi „Sprawdź kontener online", nagłówki tabeli wyników to
   * guziki („Unit Number", „ISO Type"), a bannerek ciasteczek ma własny BUTTON[type=submit]
   * „Dostosuj". Każde z tych czterech dopasowań już raz kosztowało przebieg.
   */
  function znajdzGuzik(pole) {
    const dobry = (b) =>
      b.offsetParent !== null && !wOknieZgody(b) && napis(b).length <= 30 && !ZAKAZANE.test(napis(b));
    const pasuje = (b) => /^(sprawd\S*|szukaj|wyszukaj|poka\S*|wy\S*lij|submit)$/i.test(napis(b)) ||
      (/sprawd|wyszuk|szukaj/i.test(napis(b)) && napis(b).length <= 24);
    const guziki = (zakres) =>
      [...zakres.querySelectorAll("button, input[type=submit], input[type=button], a")].filter(dobry);

    // 1. Formularz pola (gdy w ogóle istnieje).
    if (pole && pole.form) {
      const wFormularzu = guziki(pole.form);
      const trafiony = wFormularzu.find(pasuje) || wFormularzu.find((b) => (b.type || "") === "submit");
      if (trafiony) return trafiony;
    }

    // 2. Coraz szersze otoczenie pola — najbliższy guzik o właściwym napisie wygrywa.
    for (let el = pole?.parentElement, krok = 0; el && krok < 6; el = el.parentElement, krok++) {
      const trafiony = guziki(el).find(pasuje);
      if (trafiony) return trafiony;
    }

    // 3. Ostatecznie cała strona, ale WYŁĄCZNIE po dokładnym napisie.
    return guziki(document).find((b) => /^(sprawd\S*|szukaj|wyszukaj)$/i.test(napis(b))) || null;
  }

  /**
   * Tryb zapytania NIE JEST przez nas przestawiany — tylko opisywany.
   *
   * Powód: radio `seacontainer` ma dwie opcje (`once` i `multi`), a strona sama zaznacza `once`,
   * czyli dokładnie „pojedyncze zapytanie". Poprzednia wersja „pomocnie" klikała każdą odznaczoną
   * opcję pasującą do nazwy grupy i przestawiała tryb na `multi`, psując domyślny wybór.
   */
  function opiszTryb() {
    const radia = [...document.querySelectorAll("input[type=radio], input[type=checkbox]")];
    if (!radia.length) return "(brak przełączników)";
    return radia.map((r) => `${r.name || "?"}=${r.value || "?"}${r.checked ? " [zaznaczone]" : ""}`).join(", ");
  }

  /** Napis etykiety przycisku radiowego — po nim rozpoznajemy tryb, gdy `value` nic nie mówi. */
  function etykietaPola(el) {
    const zId = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const wLabel = el.closest("label");
    return napis(zId || wLabel || el.parentElement || el);
  }

  /**
   * Przestawia tryb wyszukiwania na ten, którego wymaga liczba numerów.
   *
   * TO JEST STEROWANIE, KTÓREGO WCZEŚNIEJ ŚWIADOMIE NIE BYŁO — i dlatego nic nie działało.
   * Strona ma dwie opcje: „Wyszukaj kontener" (`once`, JEDEN numer) i „* Wyszukaj więcej
   * kontenerów" (`multi`, do dziesięciu po przecinku). Domyślnie zaznaczona jest ta pierwsza,
   * więc wklejenie pięciu numerów po przecinku kończyło się odpowiedzią „Brak wyników" —
   * terminal szukał kontenera o nazwie „NR1, NR2, NR3, NR4, NR5".
   *
   * Poprzednia wersja klikała każdą odznaczoną opcję z pasującą nazwą grupy i psuła wybór; stąd
   * blokada „nie ruszamy trybu", która była o jeden krok za daleko. Teraz wybieramy KONKRETNĄ
   * opcję i sprawdzamy, czy faktycznie się zaznaczyła.
   */
  function ustawTryb(ile) {
    const radia = [...document.querySelectorAll("input[type=radio]")].filter((r) => !wOknieZgody(r));
    if (!radia.length) return { ustawiony: null, opis: "(brak przełącznika trybu)" };

    const sygnatura = (r) => `${r.value || ""} ${r.name || ""} ${etykietaPola(r)}`;
    const wiele = radia.find((r) => /multi|wiele|wi\S*cej|more|kilka/i.test(sygnatura(r)));
    const jeden = radia.find((r) => r !== wiele && /once|single|jeden|kontener/i.test(sygnatura(r)));
    const chciany = ile > 1 ? wiele : jeden || (ile > 1 ? null : radia[0]);

    if (!chciany) {
      return { ustawiony: false, opis: `nie znalazłem opcji „${ile > 1 ? "wiele kontenerów" : "jeden kontener"}”` };
    }
    if (!chciany.checked) {
      chciany.click();
      chciany.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return {
      ustawiony: chciany.checked === true,
      opis: `${ile > 1 ? "wiele" : "jeden"} → ${chciany.value || "?"} „${etykietaPola(chciany).slice(0, 40)}”${chciany.checked ? "" : " [NIE zaznaczyło się]"}`,
    };
  }

  /**
   * Okna przykrywające stronę. `modal-open` na `<body>` to ślad, który rozwiązał jedną z rund:
   * Bootstrap ustawia tę klasę, gdy nad stroną stoi okno, a jego przezroczysta warstwa
   * przechwytuje KAŻDE kliknięcie — formularz jest wtedy widoczny, ale nieklikalny.
   */
  function opisOkienek() {
    const modale = [
      ...document.querySelectorAll(".modal, [role=dialog], [id*=cookie], [class*=cookie], [id*=Cookie], [class*=Cookie]"),
    ].filter((m) => m.offsetParent !== null);
    const opis = modale.slice(0, 4).map(
      (m) =>
        `${`${m.id || m.className || "?"}`.slice(0, 50)} :: ` +
        [...m.querySelectorAll("button, a, [role=button]")]
          .slice(0, 8)
          .map((b) => napis(b).slice(0, 28))
          .filter(Boolean)
          .join(" / "),
    );
    return `body.class=${document.body?.className || "-"}${opis.length ? ` || ${opis.join(" | ")}` : ""}`;
  }

  /**
   * Zamyka to, co przykrywa stronę — przede wszystkim zgodę na ciasteczka. Bez tego klik w guzik
   * trafia w warstwę okna i nie robi NIC, a strona wygląda, jakby zignorowała wyszukiwanie.
   *
   * Napis musi być KRÓTKI i pasować do zgody — inaczej łatwo kliknąć „Odrzuć wszystkie" albo
   * przypadkowy odnośnik w treści.
   */
  function zamknijOkienka() {
    const zrobione = [];
    const zgoda = /^(akceptuj|zaakceptuj|zgadzam|zezw\S*|rozumiem|accept|allow|got it|ok)\b/i;
    const widoczny = (x) => x.offsetParent !== null;

    // 1. CookieYes po nazwie własnej — to jego bannerek stoi na baltichub.com (`ckyPreferenceCenter`
    //    w migawce z produkcji). Trafienie po klasie jest pewniejsze niż po napisie, bo nie zależy
    //    od języka strony.
    for (const b of [...document.querySelectorAll('.cky-btn-accept, [data-cky-tag="accept-button"]')].filter(widoczny)) {
      b.click();
      zrobione.push("CookieYes: akceptacja");
      break;
    }

    // 2. Zwykła zgoda po napisie — nigdy „Dostosuj", „Odrzuć wszystkie" ani „Zapisz moje preferencje".
    if (!zrobione.length) {
      for (const b of [...document.querySelectorAll("button, a, [role=button]")].filter(widoczny)) {
        const t = napis(b);
        if (t.length <= 40 && zgoda.test(t) && !ZAKAZANE.test(t)) {
          b.click();
          zrobione.push(`zgoda: „${t.slice(0, 30)}”`);
          break;
        }
      }
    }

    // 3. Krzyżyki — WYŁĄCZNIE w widocznym oknie zgody.
    //
    // Poprzednia wersja klikała każdy `.modal .close` na stronie i to okazało się szkodliwe:
    // na produkcji po tych klikach `<body>` DOSTAŁO klasę `modal-open` (czyli okno się otworzyło,
    // a nie zamknęło), po czym guzik „Dostosuj" z panelu ciasteczek stał się widoczny i został
    // kliknięty jako „wyszukiwanie". Nie ruszamy okien, których nie rozumiemy.
    for (const b of [
      ...document.querySelectorAll("[data-bs-dismiss=modal], [data-dismiss=modal], .btn-close, .close, [aria-label*=zamknij i], [aria-label*=close i]"),
    ]
      .filter((x) => widoczny(x) && wOknieZgody(x))
      .slice(0, 2)) {
      b.click();
      zrobione.push("zamknięcie okna zgody");
    }

    const otwarte = [...document.querySelectorAll("*")].some(
      (n) => n.offsetParent !== null && wOknieZgody(n) && n.getBoundingClientRect().height > 80,
    );

    return {
      zrobione: zrobione.length ? zrobione.join(" + ") : "(nic do zamknięcia)",
      po: opisOkienek(),
      // Do komunikatu błędu: „nie ma wyników" znaczy co innego, gdy nad stroną wciąż wisi zgoda.
      zgodaNadalOtwarta: otwarte,
    };
  }

  /**
   * Stan reCAPTCHY. W prawdziwej przeglądarce dyspozytora zagadka zwykle rozwiązuje się sama
   * (niewidoczna wersja ocenia zachowanie), ale gdy JEDNAK wyskoczy okno z obrazkami, nikt tego
   * nie kliknie za nas — i o tym trzeba powiedzieć CZŁOWIEKOWI, zamiast zapisać „brak wyników".
   * Stąd rozróżnienie: samo pole `g-recaptcha-response` to jeszcze nie problem, dopiero widoczne
   * okno zagadki nim jest.
   */
  function opiszZagadke() {
    const pola = [...document.querySelectorAll('[name="g-recaptcha-response"], .g-recaptcha, [data-sitekey]')];
    const okno = [...document.querySelectorAll("iframe")].filter(
      (f) => /recaptcha|challenge|hcaptcha|turnstile/i.test(`${f.title || ""} ${f.src || ""}`) && f.offsetParent !== null,
    );
    const widoczneOkno = okno.some((f) => {
      const r = f.getBoundingClientRect();
      return r.width > 120 && r.height > 120;
    });
    const wypelnione = pola.some((p) => (p.value || "").length > 0);
    return { jest: pola.length > 0, wypelnione, czekaNaCzlowieka: widoczneOkno };
  }

  function opiszStrone() {
    return {
      tytul: document.title || "",
      adres: location.href,
      formularze: [...document.querySelectorAll("form")]
        .slice(0, 10)
        .map((f) => `${f.getAttribute("method") || "GET"} ${f.getAttribute("action") || "-"}`)
        .join(" | "),
      pola: [...document.querySelectorAll("input, textarea, select")]
        .slice(0, 30)
        .map(
          (el) =>
            opisPola(el) +
            (el.type === "radio" || el.type === "checkbox" ? (el.checked ? " [zaznaczone]" : " [odznaczone]") : "") +
            (el.offsetParent === null ? " [niewidoczne]" : ""),
        )
        .join(" | "),
      guziki: [...document.querySelectorAll("button, input[type=submit]")]
        .slice(0, 20)
        .map((b) => napis(b))
        .filter(Boolean)
        .join(" | "),
      okienka: opisOkienek(),
      tekst: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
    };
  }

  /** Odpowiedź jest gotowa, gdy widać karty kontenerów albo jawne „brak wyników". */
  function maWyniki(tekst) {
    return /Karta kontenera|Brak wynik/i.test(tekst || "");
  }

  /**
   * Wpisuje numery i uruchamia wyszukiwanie tak, jak zrobiłby to człowiek.
   *
   * Wartość ustawiamy przez ustawiacz z prototypu, bo strony pisane w Reakcie/Vue nie zauważają
   * zwykłego przypisania do `value` i przy wysyłce widzą pole puste.
   */
  /**
   * Wszystko, w co dałoby się kliknąć W POBLIŻU pola — do migawki przy niepowodzeniu.
   *
   * Zmierzone na produkcji: spis guzików CAŁEJ strony (`button, input[type=submit]`) nie zawierał
   * ani jednego „Sprawdź" — same przyciski ciasteczek i EN/PL. Czyli kontrolka uruchamiająca
   * wyszukiwanie nie jest zwykłym `<button>`. Bez tej listy nie da się zgadnąć, czym jest,
   * a zgadywanie bez zobaczenia strony już raz kosztowało rundę.
   */
  function kandydaciGuzikow(pole) {
    const out = [];
    for (let el = pole?.parentElement, krok = 0; el && krok < 5; el = el.parentElement, krok++) {
      for (const b of el.querySelectorAll("button, input[type=submit], input[type=button], a, [role=button], [onclick]")) {
        if (b.offsetParent === null || wOknieZgody(b)) continue;
        const opis = `${b.tagName}[${b.type || b.getAttribute("role") || "-"}] „${napis(b).slice(0, 30)}”`;
        if (!out.includes(opis)) out.push(opis);
        if (out.length >= 12) return out.join(" | ");
      }
    }
    return out.join(" | ") || "(brak kandydatów obok pola)";
  }

  /** Enter w polu — dla stron, na których wyszukiwanie uruchamia skrypt, a nie guzik. */
  function nacisnijEnter(pole) {
    for (const typ of ["keydown", "keypress", "keyup"]) {
      pole.dispatchEvent(new KeyboardEvent(typ, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }

  function wyslij(numery, opcje) {
    const ile = (numery || []).length;

    // NAJPIERW tryb, potem pole: przestawienie przełącznika potrafi przebudować formularz
    // (strona jest skryptowana), więc pole trzeba znaleźć na nowo PO zmianie trybu.
    const ustawienie = opcje && opcje.enter ? { ustawiony: null, opis: "(drugie podejście)" } : ustawTryb(ile);
    const tryb = `${ustawienie.opis} :: ${opiszTryb()}`;

    if (ile > 1 && ustawienie.ustawiony === false) {
      return {
        wyslane: false,
        powod: `nie udało się przełączyć na wyszukiwanie wielu kontenerów (${ustawienie.opis})`,
        trybNieustawiony: true,
        tryb,
        ...opiszStrone(),
      };
    }

    const pole = znajdzPole();
    if (!pole) return { wyslane: false, powod: "nie znalazłem pola na numery", tryb, ...opiszStrone() };

    // Drugie podejście: pole jest już wypełnione, więc tylko naciskamy Enter.
    if (opcje && opcje.enter) {
      pole.focus();
      nacisnijEnter(pole);
      return { wyslane: true, sposob: "Enter (drugie podejście)", tryb, pole: opisPola(pole), wpisano: pole.value };
    }

    const wartosc = (numery || []).join(", ");
    const ustawiacz = Object.getOwnPropertyDescriptor(pole.constructor.prototype, "value")?.set;
    if (ustawiacz) ustawiacz.call(pole, wartosc);
    else pole.value = wartosc;
    pole.dispatchEvent(new Event("input", { bubbles: true }));
    pole.dispatchEvent(new Event("change", { bubbles: true }));

    const guzik = znajdzGuzik(pole);
    const uzyte = {
      tryb,
      pole: opisPola(pole),
      guzik: opisGuzika(guzik),
      wpisano: pole.value,
      okienka: opisOkienek(),
      kandydaci: kandydaciGuzikow(pole),
    };

    if (guzik) {
      guzik.click();
      return { wyslane: true, sposob: "klik w guzik", ...uzyte };
    }
    const form = pole.form;
    if (form && form.requestSubmit) {
      form.requestSubmit();
      return { wyslane: true, sposob: "requestSubmit", ...uzyte };
    }
    if (form) {
      form.submit();
      return { wyslane: true, sposob: "form.submit", ...uzyte };
    }
    pole.focus();
    nacisnijEnter(pole);
    return { wyslane: true, sposob: "Enter", ...uzyte };
  }

  /**
   * Punkty do KLIKNIĘCIA MYSZĄ (środek pola i środek guzika, we współrzędnych okna).
   *
   * Potrzebne, bo klikanie z kodu (`element.click()`) nie wystarcza: zdarzenie ma
   * `isTrusted === false`, reCAPTCHA na tym formularzu się nie uruchamia i terminal oddaje pustą
   * listę wyników. Prawdziwe kliknięcia wysyła `input.js` przez protokół debugowania i potrzebuje
   * do tego współrzędnych — stąd ta funkcja.
   *
   * Pole przewijamy na środek okna PRZED pomiarem, bo w punkt poza widocznym obszarem nie da się
   * kliknąć. Guzik mierzymy po tym samym przewinięciu (na tej stronie stoi tuż obok pola).
   */
  function wskazniki() {
    const pole = znajdzPole();
    if (!pole) return { ok: false, powod: "nie znalazłem pola na numery", ...opiszStrone() };
    pole.scrollIntoView({ block: "center", inline: "center" });

    const srodek = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const wOknie = (p) => p.w > 0 && p.h > 0 && p.x > 0 && p.y > 0 && p.y < innerHeight && p.x < innerWidth;

    const guzik = znajdzGuzik(pole);
    const punktPola = srodek(pole);
    const punktGuzika = guzik ? srodek(guzik) : null;

    // Czyścimy pole przed pisaniem — wpisanie po staremu nie wymaga zaufanego zdarzenia,
    // a zostawiony numer z poprzedniej paczki dokleiłby się do nowego.
    const ustawiacz = Object.getOwnPropertyDescriptor(pole.constructor.prototype, "value")?.set;
    if (ustawiacz) ustawiacz.call(pole, "");
    else pole.value = "";
    pole.dispatchEvent(new Event("input", { bubbles: true }));

    return {
      ok: wOknie(punktPola),
      pole: punktPola,
      guzik: punktGuzika && wOknie(punktGuzika) ? punktGuzika : null,
      opisPola: opisPola(pole),
      opisGuzika: opisGuzika(guzik),
      tryb: opiszTryb(),
      kandydaci: kandydaciGuzikow(pole),
    };
  }

  globalThis.__bhub = {
    /** Czy strona jest gotowa do wypełnienia (przeszła weryfikację Cloudflare i ma pole). */
    stan: () => ({ gotowa: Boolean(znajdzPole()), zagadka: opiszZagadke(), ...opiszStrone() }),
    ustawTryb: (ile) => ustawTryb(ile),
    wskazniki,

    /**
     * Co NAPRAWDĘ jest w formularzu tuż przed wysłaniem — czytane ze strony, nie z naszych założeń.
     *
     * Powód: przez kilka rund terminal odpowiadał „Brak wyników:" BEZ numeru, czyli dostawał puste
     * zapytanie, a my nie mieliśmy jak odróżnić „numer nie trafił do pola" od „numer trafił, ale
     * serwis odrzucił zapytanie". Te cztery wartości rozstrzygają to jednym przebiegiem:
     *   wartosc      — czy numer faktycznie stoi w polu,
     *   aktywny      — czy pisaliśmy do TEGO pola, czy do innego elementu,
     *   widocznosc   — karta w tle jest dla strony „ukryta"; część zabezpieczeń wtedy nie działa,
     *   zagadka      — czy reCAPTCHA wypełniła swoje ukryte pole (czyli czy w ogóle się uruchomiła).
     */
    stanPola: () => {
      const pole = znajdzPole();
      return {
        wartosc: pole ? pole.value : "(brak pola)",
        aktywny: document.activeElement ? opisPola(document.activeElement) : "-",
        widocznosc: document.visibilityState,
        fokus: document.hasFocus(),
        zagadka: opiszZagadke(),
      };
    },
    zamknij: () => zamknijOkienka(),
    wyslij,
    /**
     * Widoczny tekst strony — z niego funkcja brzegowa czyta Karty kontenera.
     *
     * KOLEJNOŚĆ POLA `tekst` MA ZNACZENIE i już raz kosztowała cały przebieg: `opiszStrone()`
     * zwraca WŁASNE pole `tekst` — skrócony do 300 znaków podgląd do diagnozy. Gdy stało ono
     * w rozwinięciu ZA pełnym tekstem, nadpisywało go i do serwera szło samo menu strony
     * („Nie rozpoznałem odpowiedzi Baltic Hub (300 znaków)"), mimo że wyszukiwanie działało,
     * a wyniki były na ekranie. Pełny tekst musi być OSTATNI; podgląd jedzie pod inną nazwą.
     */
    wyniki: () => {
      const tekst = document.body?.innerText || "";
      const opis = opiszStrone();
      return { ...opis, podglad: opis.tekst, zagadka: opiszZagadke(), gotowe: maWyniki(tekst), tekst };
    },
    maWyniki,
  };
})();
