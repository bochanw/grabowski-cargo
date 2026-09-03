// Skąd bierzemy stronę Baltic Hub z wynikiem dla kontenera.
//
// ================== DLACZEGO TO JEST WYMIENNE ==================
// Sprawdzone 2026-09-03 na trzech niezależnych ścieżkach: baltichub.com stoi za Cloudflare
// "managed challenge" i odrzuca WSZYSTKO, co nie jest przeglądarką na zwykłym łączu —
// zwykły curl, prawdziwy Chromium z serwerowni ORAZ Edge Function tego właśnie projektu
// dostały identyczne `403` z nagłówkiem `cf-mitigated: challenge` (403 wraca nawet na
// /robots.txt, więc blokada jest na całą domenę, nie na sam formularz).
//
// Stąd tryb `brightdata`: Bright Data Web Unlocker pobiera stronę za nas prawdziwą przeglądarką
// z adresu, któremu Cloudflare ufa, i zwraca gotowy HTML. Tryb `direct` (zwykły fetch) zostaje,
// bo nic nie kosztuje i pozwala odróżnić "nie działa transport" od "nie działa parser".
//
// Przełączenie źródła to zmiana JEDNEJ zmiennej środowiskowej — cała reszta potoku (wybór zleceń,
// rozpoznanie statusu, zapis, dziennik) jest wspólna i nie wie, skąd przyszedł HTML. Ten sam
// wzorzec co przy skrzynce (MAIL_SOURCE: graph vs imap).
// ===============================================================

export interface StatusSource {
  readonly name: string;
  /** Zwraca HTML strony z wynikiem dla podanego numeru kontenera. Rzuca przy błędzie transportu. */
  fetchContainerPage(containerNumber: string): Promise<string>;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Adres strony z wynikiem oraz sposób wysłania zapytania. Formularz Baltic Hub okazał się
 * ZWYKŁĄ STRONĄ z polem i guzikiem „Sprawdź" (Vehicle Booking System, aplikacja jQuery), a nie
 * adresem z numerem w parametrze — pierwszy przebieg przez Bright Datę zwrócił pusty formularz.
 * Dlatego sposób wysyłki jest w całości konfigurowalny, bez zmiany kodu:
 *
 *   BHUB_CONTAINER_URL          adres; `{container}` zostaje podmienione na numer kontenera
 *   BHUB_CONTAINER_METHOD       GET (domyślnie) albo POST
 *   BHUB_CONTAINER_BODY         treść POST-a, też z `{container}`; ustawienie jej wymusza POST
 *   BHUB_RENDER                 "true" = Bright Data uruchamia stronę w przeglądarce (drożej,
 *                               ale konieczne, gdy wynik dorysowuje JavaScript)
 *   BHUB_COUNTRY                kraj adresu wyjściowego, np. "pl"
 */
const DEFAULT_URL_TEMPLATE = "https://ebrama.baltichub.com/vbs-check-container";

function fill(template: string, containerNumber: string, encode: boolean): string {
  return template.replace("{container}", encode ? encodeURIComponent(containerNumber) : containerNumber);
}

export function containerUrl(containerNumber: string): string {
  return fill(Deno.env.get("BHUB_CONTAINER_URL") ?? DEFAULT_URL_TEMPLATE, containerNumber, true);
}

/** Zwykły fetch — patrz nagłówek pliku: dziś odbija się o Cloudflare. */
class DirectSource implements StatusSource {
  readonly name = "direct";

  async fetchContainerPage(containerNumber: string): Promise<string> {
    const res = await fetch(containerUrl(containerNumber), {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "pl-PL,pl;q=0.9",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      const mitigated = res.headers.get("cf-mitigated");
      if (res.status === 403 && (mitigated || /Just a moment|cf-chl|Cierpliwo/i.test(text))) {
        throw new Error(
          "Baltic Hub odrzucił zapytanie (Cloudflare). Odczyt wprost z serwera nie działa — " +
            "ustaw BHUB_SOURCE=brightdata i sekrety Bright Data."
        );
      }
      throw new Error(`Baltic Hub odpowiedział HTTP ${res.status}.`);
    }
    return text;
  }
}

/**
 * Bright Data Web Unlocker — https://api.brightdata.com/request, jedno zapytanie POST, w odpowiedzi
 * surowy HTML strony docelowej (`format: "raw"`). Bright Data bierze na siebie rotację adresów,
 * odciski przeglądarki i CAPTCHA.
 *
 * Konfiguracja to DWA sekrety (Project Settings → Edge Functions → Secrets):
 *   BRIGHTDATA_API_TOKEN — token z panelu Bright Data
 *   BRIGHTDATA_ZONE      — nazwa strefy typu Web Unlocker
 * Adres API jest wpisany na stałe świadomie: to jeden endpoint dla całej usługi, a każdy kolejny
 * sekret to kolejne miejsce, w którym da się zrobić literówkę.
 */
class BrightDataSource implements StatusSource {
  readonly name = "brightdata";

  async fetchContainerPage(containerNumber: string): Promise<string> {
    const token = Deno.env.get("BRIGHTDATA_API_TOKEN");
    const zone = Deno.env.get("BRIGHTDATA_ZONE");
    if (!token || !zone) {
      throw new Error(
        "Brak konfiguracji Bright Data — uzupełnij sekrety BRIGHTDATA_API_TOKEN i BRIGHTDATA_ZONE " +
          "w Project Settings → Edge Functions → Secrets."
      );
    }

    // Pola wg dokumentacji Bright Daty (zone/url/format wymagane; method/body/render/country
    // opcjonalne). Wysyłamy tylko te, które faktycznie ustawiono — pusty `body` przy GET potrafi
    // zmienić zachowanie po stronie usługi.
    const payload: Record<string, string> = { zone, url: containerUrl(containerNumber), format: "raw" };
    const bodyTemplate = Deno.env.get("BHUB_CONTAINER_BODY");
    const method = (Deno.env.get("BHUB_CONTAINER_METHOD") ?? (bodyTemplate ? "POST" : "GET")).toUpperCase();
    if (method !== "GET") payload.method = method;
    if (bodyTemplate) payload.body = fill(bodyTemplate, containerNumber, true);
    if (Deno.env.get("BHUB_RENDER") === "true") payload.render = "true";
    const country = Deno.env.get("BHUB_COUNTRY");
    if (country) payload.country = country;

    const res = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const text = await res.text();

    if (!res.ok) {
      // Treść błędu Bright Daty bywa jedyną informacją, czemu nie działa (zły token, wyczerpany
      // limit, nieistniejąca strefa) — przycinamy, ale nie gubimy: ten komunikat ląduje w appce
      // przy zleceniu i jest widoczny w dymku komórki statusu.
      throw new Error(`Bright Data zwróciła HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    // Bright Data potrafi zwrócić 200 z własnym błędem w treści, gdy nie zdołała odblokować strony.
    if (/^\s*\{"error"/.test(text)) {
      throw new Error(`Bright Data nie pobrała strony: ${text.slice(0, 300)}`);
    }
    return text;
  }
}

export function createStatusSource(): StatusSource {
  return (Deno.env.get("BHUB_SOURCE") ?? "direct") === "brightdata" ? new BrightDataSource() : new DirectSource();
}
