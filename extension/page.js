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

  const widocznePola = () =>
    [...document.querySelectorAll("input, textarea")].filter((el) => el.type !== "hidden" && el.offsetParent !== null);

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
  function znajdzGuzik(pole) {
    const zakres = (pole && pole.form) || document;
    const wszystkie = [...zakres.querySelectorAll("button, input[type=submit], input[type=button], a")].filter(
      (b) => b.offsetParent !== null,
    );

    return (
      wszystkie.find(
        (b) => (b.type || "") === "submit" && !/search|szukaj/i.test((b.form && b.form.getAttribute("action")) || ""),
      ) ||
      wszystkie.find((b) => /^(sprawd\S*|szukaj|wyszukaj|poka\S*)$/i.test(napis(b))) ||
      wszystkie.find((b) => napis(b).length <= 24 && /sprawd|wyszuk/i.test(napis(b)) && !/online/i.test(napis(b))) ||
      null
    );
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
    const odmowa = /odrzu|nie zgadzam|reject|decline|ustawienia|settings/i;

    for (const b of [...document.querySelectorAll("button, a, [role=button]")].filter((x) => x.offsetParent !== null)) {
      const t = napis(b);
      if (t.length <= 40 && zgoda.test(t) && !odmowa.test(t)) {
        b.click();
        zrobione.push(`zgoda: „${t.slice(0, 30)}”`);
        break;
      }
    }

    for (const b of [
      ...document.querySelectorAll("[data-bs-dismiss=modal], [data-dismiss=modal], .modal .btn-close, .modal .close"),
    ]
      .filter((x) => x.offsetParent !== null)
      .slice(0, 3)) {
      b.click();
      zrobione.push("zamknięcie okna");
    }

    return {
      zrobione: zrobione.length ? zrobione.join(" + ") : "(nic do zamknięcia)",
      po: opisOkienek(),
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
  function wyslij(numery) {
    const tryb = opiszTryb();
    const pole = znajdzPole();
    if (!pole) return { wyslane: false, powod: "nie znalazłem pola na numery", tryb, ...opiszStrone() };

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
    pole.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    return { wyslane: true, sposob: "Enter", ...uzyte };
  }

  globalThis.__bhub = {
    /** Czy strona jest gotowa do wypełnienia (przeszła weryfikację Cloudflare i ma pole). */
    stan: () => ({ gotowa: Boolean(znajdzPole()), zagadka: opiszZagadke(), ...opiszStrone() }),
    zamknij: () => zamknijOkienka(),
    wyslij,
    /** Widoczny tekst strony — z niego funkcja brzegowa czyta Karty kontenera. */
    wyniki: () => {
      const tekst = document.body?.innerText || "";
      return { tekst, gotowe: maWyniki(tekst), zagadka: opiszZagadke(), ...opiszStrone() };
    },
    maWyniki,
  };
})();
