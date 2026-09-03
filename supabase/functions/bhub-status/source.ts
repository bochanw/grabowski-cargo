// Skąd bierzemy stronę Baltic Hub z wynikiem dla kontenera.
//
// ================== DLACZEGO TO JEST WYMIENNE ==================
// Sprawdzone 2026-09-03 na trzech niezależnych ścieżkach: baltichub.com stoi za Cloudflare
// "managed challenge" i odrzuca WSZYSTKO, co nie jest przeglądarką na zwykłym łączu —
// zwykły curl, prawdziwy Chromium z serwerowni ORAZ Edge Function tego właśnie projektu
// dostały identyczne `403` z nagłówkiem `cf-mitigated: challenge` (403 wraca nawet na
// /robots.txt, więc blokada jest na całą domenę, nie na sam formularz).
//
// Wniosek: tryb `direct` NIE ZADZIAŁA, dopóki blokada obowiązuje — jest tu, bo nic nie kosztuje,
// bo blokada bywa zdejmowana i bo pozwala odróżnić "nie działa transport" od "nie działa parser".
// Realnie odpytywanie wymaga usługi, która przechodzi przez Cloudflare (tryb `proxy`).
//
// Przełączenie źródła to zmiana JEDNEJ zmiennej środowiskowej — cała reszta potoku (wybór
// zleceń, rozpoznanie statusu, zapis, dziennik) jest wspólna i nie wie, skąd przyszedł HTML.
// Ten sam wzorzec co przy skrzynce (MAIL_SOURCE: graph vs imap).
// ===============================================================

export interface StatusSource {
  readonly name: string;
  /** Zwraca HTML strony z wynikiem dla podanego numeru kontenera. Rzuca przy błędzie transportu. */
  fetchContainerPage(containerNumber: string): Promise<string>;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Adres strony z wynikiem. DO POTWIERDZENIA na żywej stronie — z tego środowiska nie dało się jej
 * otworzyć (Cloudflare), więc nie wiemy, czy formularz wysyła GET z numerem w adresie, czy POST.
 * Zamiast zgadywać w kodzie, kształt adresu jest zmienną środowiskową: `{container}` w szablonie
 * zostaje podmienione na numer kontenera.
 */
const DEFAULT_URL_TEMPLATE = "https://ebrama.baltichub.com/vbs-check-container?container={container}";

export function containerUrl(containerNumber: string): string {
  const template = Deno.env.get("BHUB_CONTAINER_URL") ?? DEFAULT_URL_TEMPLATE;
  return template.replace("{container}", encodeURIComponent(containerNumber));
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
      // Rozpoznajemy blokadę wprost, żeby w appce nie stało bezużyteczne "HTTP 403".
      const mitigated = res.headers.get("cf-mitigated");
      if (res.status === 403 && (mitigated || /Just a moment|cf-chl|Cierpliwo/i.test(text))) {
        throw new Error(
          "Baltic Hub odrzucił zapytanie (Cloudflare). Odczyt z serwera wymaga usługi przechodzącej " +
            "przez zabezpieczenie — ustaw BHUB_SOURCE=proxy i klucz usługi."
        );
      }
      throw new Error(`Baltic Hub odpowiedział HTTP ${res.status}.`);
    }
    return text;
  }
}

/**
 * Usługa pobierająca stronę za nas prawdziwą przeglądarką z adresu, któremu Cloudflare ufa.
 * Obsłużone są dwa kształty API, bo wszystkie popularne usługi mieszczą się w jednym z nich:
 *
 *   BHUB_PROXY_KIND=get   — klucz i adres w parametrach (ScrapingBee, ScraperAPI, ZenRows)
 *   BHUB_PROXY_KIND=post  — klucz w nagłówku, adres w ciele JSON (Bright Data Web Unlocker)
 *
 * Reszta w zmiennych, żeby zmiana dostawcy ani zmiana nazw parametrów nie wymagała wdrożenia:
 *   BHUB_PROXY_ENDPOINT  — adres API usługi
 *   BHUB_PROXY_KEY       — klucz
 *   BHUB_PROXY_PARAMS    — dodatkowe parametry/pola jako JSON, np. {"render_js":"true"}
 */
class ProxySource implements StatusSource {
  readonly name = "proxy";

  async fetchContainerPage(containerNumber: string): Promise<string> {
    const endpoint = Deno.env.get("BHUB_PROXY_ENDPOINT");
    const key = Deno.env.get("BHUB_PROXY_KEY");
    if (!endpoint || !key) {
      throw new Error(
        "Brak konfiguracji usługi pobierającej stronę (BHUB_PROXY_ENDPOINT / BHUB_PROXY_KEY) — " +
          "uzupełnij sekrety Edge Functions."
      );
    }
    const extra = JSON.parse(Deno.env.get("BHUB_PROXY_PARAMS") ?? "{}") as Record<string, unknown>;
    const target = containerUrl(containerNumber);
    const kind = Deno.env.get("BHUB_PROXY_KIND") ?? "get";

    const res =
      kind === "post"
        ? await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ url: target, format: "raw", ...extra }),
          })
        : await (() => {
            const url = new URL(endpoint);
            url.searchParams.set(Deno.env.get("BHUB_PROXY_KEY_PARAM") ?? "api_key", key);
            url.searchParams.set(Deno.env.get("BHUB_PROXY_URL_PARAM") ?? "url", target);
            for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
            return fetch(url);
          })();

    const text = await res.text();
    if (!res.ok) {
      // Treść błędu usługi bywa jedyną informacją, czemu nie działa (wyczerpany limit, zły klucz) —
      // przycinamy, ale nie gubimy: ten komunikat ląduje w appce przy zleceniu.
      throw new Error(`Usługa pobierająca stronę zwróciła HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text;
  }
}

export function createStatusSource(): StatusSource {
  return (Deno.env.get("BHUB_SOURCE") ?? "direct") === "proxy" ? new ProxySource() : new DirectSource();
}
