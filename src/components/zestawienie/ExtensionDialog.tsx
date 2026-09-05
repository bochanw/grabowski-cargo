"use client";

import { useExtensionPackage } from "@/hooks/useExtensionPackage";
import { useTerminalSources, type DrogaTerminala } from "@/hooks/useTerminalSources";
import { adresPaczki, stanPaczki } from "@/lib/bhub/extensionPackage";
import type { StanRozszerzenia } from "@/lib/bhub/extensionBridge";

// Okno „Wtyczka" — pobranie aktualnej paczki rozszerzenia do Chrome i instrukcja, co z nią zrobić.
//
// Wtyczka siedzi na komputerze każdego dyspozytora, a poprawki w niej wychodzą po każdym zderzeniu
// z żywym Baltic Hubem. Bez tego okna aktualizacja znaczyła: „poproś kogoś o katalog z repozytorium"
// — czyli w praktyce część ludzi zostaje na starej wersji i nikt tego nie widzi.

function rozmiar(bajty: number): string {
  return bajty > 0 ? `${Math.round(bajty / 1024)} kB` : "—";
}

function data(iso: string): string {
  return iso ? new Date(iso).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—";
}

export function ExtensionDialog({ extension, onClose }: { extension: StanRozszerzenia | null; onClose: () => void }) {
  const { data: paczka, isLoading, error } = useExtensionPackage();
  const zainstalowana = extension?.zainstalowane ? (extension.wersja ?? "nieznana") : null;
  const stan = stanPaczki(paczka ?? null, extension?.zainstalowane ? (extension.wersja ?? "0") : null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Wtyczka do Chrome — statusy z terminali</h2>
          <button type="button" onClick={onClose} aria-label="Zamknij" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto px-4 py-4 text-sm text-zinc-700 dark:text-zinc-300">
          {error ? (
            <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              {error instanceof Error ? error.message : "Nie udało się odczytać paczki z wtyczką."}
            </p>
          ) : isLoading ? (
            <p className="text-xs text-zinc-500">Sprawdzam, jaka wersja jest do pobrania…</p>
          ) : paczka ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <a
                  href={adresPaczki(paczka)}
                  download={paczka.nazwaPliku}
                  className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  Pobierz wtyczkę {paczka.wersja}
                </a>
                <span className="text-xs text-zinc-500">
                  {paczka.plikow} plików, {rozmiar(paczka.rozmiar)} · spakowane {data(paczka.zbudowano)}
                </span>
              </div>

              {/* Co jest w TEJ przeglądarce. Brak wtyczki tutaj nie jest awarią — statusy sprawdza
                  jeden komputer za wszystkich — ale STARA wersja jest, bo wtedy poprawki dotyczące
                  strony terminala u tej osoby nie działają. */}
              <p
                className={`rounded border px-3 py-2 text-xs ${
                  stan === "stara"
                    ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
                    : stan === "aktualna"
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                }`}
              >
                {stan === "stara"
                  ? `W tej przeglądarce działa wersja ${zainstalowana} — zaktualizuj ją do ${paczka.wersja} (kroki niżej).`
                  : stan === "aktualna"
                    ? `W tej przeglądarce działa wersja ${zainstalowana} — aktualna.`
                    : stan === "nowsza"
                      ? `W tej przeglądarce działa wersja ${zainstalowana}, nowsza niż paczka (${paczka.wersja}) — czyli katalog wgrany wprost z repozytorium.`
                      : `W tej przeglądarce nie widzę wtyczki. Statusy i tak się odświeżają, jeśli ma ją włączony ktoś inny — ale na tym komputerze nic nie sprawdzi.`}
              </p>

              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {zainstalowana ? "Aktualizacja (1 minuta)" : "Instalacja (5 minut, raz na komputer)"}
                </h3>
                <ol className="list-decimal space-y-1 pl-5 text-xs">
                  <li>
                    Pobierz paczkę powyżej i rozpakuj ją — powstanie katalog{" "}
                    <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{paczka.katalogWZip}</code>.
                  </li>
                  {zainstalowana ? (
                    <>
                      <li>
                        Podmień nim katalog, który wskazałeś Chrome przy instalacji (ta sama nazwa — nadpisz pliki).
                      </li>
                      <li>
                        Otwórz <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">chrome://extensions</code> i kliknij
                        strzałkę <strong>Odśwież</strong> na kafelku wtyczki. Logowanie zostaje — nie trzeba go powtarzać.
                      </li>
                    </>
                  ) : (
                    <>
                      <li>
                        Otwórz <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">chrome://extensions</code> i włącz{" "}
                        <strong>Tryb dewelopera</strong> (prawy górny róg).
                      </li>
                      <li>
                        Kliknij <strong>Załaduj rozpakowane</strong> i wskaż rozpakowany katalog.
                      </li>
                      <li>Kliknij ikonę wtyczki na pasku Chrome i zaloguj się tym samym e-mailem i hasłem, co w appce.</li>
                    </>
                  )}
                </ol>
                <p className="mt-2 text-xs text-zinc-500">
                  Katalog rozpakuj w stałe miejsce (np. Dokumenty) i go nie kasuj — Chrome wczytuje wtyczkę z dysku przy
                  każdym uruchomieniu. Pełny opis działania jest w pliku <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">README.md</code> w paczce.
                </p>
              </div>
            </>
          ) : null}

          <TerminaleISposobOdczytu />
        </div>
      </div>
    </div>
  );
}

/**
 * Podział pracy między serwer a wtyczkę — i przełącznik awaryjny.
 *
 * Stoi w tym oknie, a nie w osobnym, bo odpowiada na pytanie, które dyspozytor zadaje sobie
 * właśnie tutaj: „skoro mam wtyczkę, to co ona właściwie sprawdza?". Od kiedy BCT i GCT pobiera
 * serwer, wtyczka jest potrzebna WYŁĄCZNIE do Baltic Huba — i do awarii.
 */
function TerminaleISposobOdczytu() {
  const { drogi, isLoading, przestaw } = useTerminalSources();
  if (isLoading || drogi.length === 0) return null;

  return (
    <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Skąd biorą się statusy</h3>
      <p className="mb-2 text-xs text-zinc-500">
        Terminale publiczne (bez logowania) pobiera serwer sam co 15 minut — do tego nie trzeba mieć nic włączonego.
        Wtyczka jest do Baltic Huba (Cloudflare i reCAPTCHA przepuszczają tylko prawdziwą przeglądarkę) i jako
        zabezpieczenie: jeśli publiczny terminal zacznie się bronić albo zmieni formularz, przestaw go tutaj na wtyczkę.
      </p>

      <ul className="space-y-1">
        {drogi.map((d) => (
          <li key={d.terminal} className="flex items-center gap-2 text-xs">
            <span className="w-12 font-medium text-zinc-800 dark:text-zinc-200">{d.terminal}</span>
            <select
              value={d.mode}
              disabled={przestaw.isPending}
              onChange={(e) => przestaw.mutate({ terminal: d.terminal, mode: e.target.value as DrogaTerminala })}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="serwer">serwer (sam, co 15 min)</option>
              <option value="wtyczka">wtyczka (przeglądarka dyspozytora)</option>
            </select>
            {d.terminal === "BHub" && d.mode === "serwer" ? (
              <span className="text-amber-700 dark:text-amber-400">
                ⚠ Baltic Hub odrzuca zapytania z serwera (403) — zostaw wtyczkę.
              </span>
            ) : (
              <span className="text-zinc-500">{d.note}</span>
            )}
          </li>
        ))}
      </ul>

      {przestaw.isError ? (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          Nie udało się przestawić: {przestaw.error instanceof Error ? przestaw.error.message : "nieznany błąd"}
        </p>
      ) : null}
    </div>
  );
}
