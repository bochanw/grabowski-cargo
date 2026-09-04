"use client";

import { Fragment, useMemo, useState } from "react";
import { useLoads, useUpdateLoad } from "@/hooks/useLoads";
import { useDriverRates } from "@/hooks/useDriverRates";
import { autoDriverRate } from "@/lib/driverRates/assign";
import { computeDriverRate, formatPostalCode, loadRateInput } from "@/lib/driverRates/rates";
import {
  availableMonths,
  formatMonth,
  monthKeyOf,
  monthlyCsv,
  summarizeMonth,
  BEZ_DATY,
} from "@/lib/driverRates/monthly";
import { DIRECTION_SHORT } from "@/lib/loads/direction";
import { CennikPanel } from "./CennikPanel";
import type { Load } from "@/types/load";

function zl(amount: number): string {
  return `${amount.toLocaleString("pl-PL", { maximumFractionDigits: 2 })} zł`;
}

/**
 * Miesięczne zestawienie stawek dla kierowców — trzecia zakładka obok Zestawienia i Planu
 * wspaniałego (wybór właściciela). Czyta TE SAME zlecenia co pozostałe widoki, tylko inaczej je
 * grupuje: miesiąc → kierowca → jego zlecenia. Poprawka stawki w Zestawieniu widać tu od razu.
 */
export function StawkiView() {
  const { data: loads = [], isLoading, error } = useLoads();
  const { data: rates = [] } = useDriverRates();
  const updateLoad = useUpdateLoad();
  const [rozwiniety, setRozwiniety] = useState<string | null>(null);
  const [komunikat, setKomunikat] = useState<string | null>(null);
  const [przeliczanie, setPrzeliczanie] = useState(false);
  const [pokazCennik, setPokazCennik] = useState(false);

  const miesiace = useMemo(() => availableMonths(loads), [loads]);
  const biezacy = new Date().toISOString().slice(0, 7);
  const [miesiac, setMiesiac] = useState<string | null>(null);
  // Domyślnie bieżący miesiąc — także wtedy, gdy nie ma w nim jeszcze ani jednego zlecenia
  // (pusty miesiąc to prawdziwa odpowiedź, a nie powód, żeby pokazać przypadkowy inny).
  const wybrany = miesiac ?? (miesiace.includes(biezacy) ? biezacy : (miesiace[0] ?? biezacy));

  const podsumowanie = useMemo(() => summarizeMonth(loads, wybrany), [loads, wybrany]);

  /**
   * Przelicza stawki zleceń tego miesiąca z cennika. Zlecenia ze stawką wpisaną ręcznie są
   * pomijane (`autoDriverRate` zwraca dla nich null) — inaczej jedno kliknięcie skasowałoby
   * wszystkie ręczne ustalenia z kierowcami.
   */
  async function przelicz() {
    setPrzeliczanie(true);
    setKomunikat(null);
    const doPrzeliczenia = loads.filter((load) => monthKeyOf(load) === wybrany);
    let zmienione = 0;
    let pominiete = 0;
    let bledy = 0;
    for (const load of doPrzeliczenia) {
      const auto = autoDriverRate(load, rates);
      if (!auto.patch) {
        if (load.driver_rate === null) pominiete += 1;
        continue;
      }
      const error = await updateLoad(load.id, auto.patch);
      if (error) bledy += 1;
      else zmienione += 1;
    }
    setPrzeliczanie(false);
    setKomunikat(
      `Przeliczono ${formatMonth(wybrany)}: zmienionych ${zmienione}, bez stawki ${pominiete}` +
        (bledy > 0 ? `, błędów zapisu ${bledy}` : "") +
        ". Stawki wpisane ręcznie zostały nietknięte."
    );
  }

  function pobierzCsv() {
    const csv = monthlyCsv(podsumowanie, wybrany);
    // BOM, żeby polski Excel otworzył plik w UTF-8 zamiast rozsypać ogonki.
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stawki-kierowcow-${wybrany}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) return <p className="p-4 text-sm text-zinc-500">Wczytuję zlecenia…</p>;
  if (error) return <p className="p-4 text-sm text-red-600">Nie udało się wczytać zleceń: {String(error)}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Stawki kierowców</span>
        <select
          data-testid="wybor-miesiaca"
          value={wybrany}
          onChange={(e) => setMiesiac(e.target.value)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          {[...new Set([wybrany, ...miesiace])].map((key) => (
            <option key={key} value={key}>
              {formatMonth(key)}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-500" data-testid="suma-miesiaca">
          {podsumowanie.loadsCount} zleceń · razem {zl(podsumowanie.total)}
          {podsumowanie.withoutRate > 0 ? ` · bez stawki: ${podsumowanie.withoutRate}` : ""}
        </span>
        <button
          type="button"
          onClick={przelicz}
          disabled={przeliczanie || rates.length === 0}
          data-testid="guzik-przelicz"
          className="rounded-full border border-zinc-300 px-3 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
        >
          {przeliczanie ? "Przeliczam…" : "Przelicz stawki z cennika"}
        </button>
        <button
          type="button"
          onClick={pobierzCsv}
          className="rounded-full border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700"
        >
          Pobierz CSV
        </button>
        <button
          type="button"
          onClick={() => setPokazCennik((v) => !v)}
          className="rounded-full border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700"
        >
          {pokazCennik ? "Ukryj cennik" : `Cennik (${rates.length} kodów)`}
        </button>
      </div>

      {komunikat && (
        <p className="border-b border-zinc-200 bg-emerald-50 px-4 py-1.5 text-xs text-emerald-900 dark:border-zinc-800 dark:bg-emerald-950 dark:text-emerald-100">
          {komunikat}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {podsumowanie.rows.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {wybrany === BEZ_DATY ? "Nie ma zleceń bez daty." : `Brak zleceń w miesiącu ${formatMonth(wybrany)}.`}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-2 py-1">Kierowca</th>
                  <th className="px-2 py-1 text-right">Zleceń</th>
                  <th className="px-2 py-1 text-right">Razem</th>
                  <th className="px-2 py-1">Uwagi</th>
                </tr>
              </thead>
              <tbody>
                {podsumowanie.rows.map((row) => {
                  const otwarty = rozwiniety === row.driver;
                  return (
                    <Fragment key={row.driver || "(bez kierowcy)"}>
                      <tr
                        data-testid="wiersz-kierowcy"
                        data-kierowca={row.driver}
                        onClick={() => setRozwiniety(otwarty ? null : row.driver)}
                        className="cursor-pointer border-b border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                      >
                        <td className="px-2 py-1 font-medium">
                          {otwarty ? "▾ " : "▸ "}
                          {row.driver || "(bez kierowcy)"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{row.loads.length}</td>
                        <td className="px-2 py-1 text-right font-semibold tabular-nums" data-testid="suma-kierowcy">
                          {zl(row.total)}
                        </td>
                        <td className="px-2 py-1 text-xs text-zinc-500">
                          {[
                            row.withoutRate > 0 ? `${row.withoutRate} bez stawki` : "",
                            row.manual > 0 ? `${row.manual} ręcznie` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </td>
                      </tr>
                      {otwarty &&
                        row.loads.map((load) => (
                          <tr key={load.id} data-testid="wiersz-zlecenia" className="border-b border-zinc-100 text-xs dark:border-zinc-900">
                            <td className="px-2 py-1 pl-6" colSpan={2}>
                              <span className="text-zinc-500">{load.load_date ?? "bez daty"}</span>{" "}
                              <span className="font-medium">{load.order_number ?? "(bez numeru)"}</span>{" "}
                              <span className="text-zinc-500">
                                {DIRECTION_SHORT[load.direction]} · {load.city ?? "?"}
                                {load.postal_code ? ` (${formatPostalCode(load.postal_code)})` : ""}
                              </span>
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums">
                              {load.driver_rate === null ? <span className="text-amber-600">brak</span> : zl(load.driver_rate)}
                            </td>
                            <td className="px-2 py-1 text-zinc-500">{opisStawki(load, rates)}</td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {pokazCennik && <CennikPanel onClose={() => setPokazCennik(false)} />}
      </div>
    </div>
  );
}

/**
 * Jedno zdanie „skąd ta kwota" przy zleceniu. Przy braku stawki mówi WPROST, czego zabrakło
 * (kodu pocztowego, wagi, wiersza w cenniku) — inaczej pusta komórka nie podpowiadałaby, co
 * poprawić, żeby stawka się policzyła.
 */
function opisStawki(load: Load, rates: Parameters<typeof computeDriverRate>[1]): string {
  if (load.driver_rate_source === "manual") return load.driver_rate === null ? "wyczyszczone ręcznie" : "wpisana ręcznie";
  if (load.driver_rate !== null) return load.driver_rate_code ? `cennik ${load.driver_rate_code}` : "";
  const zCennika = computeDriverRate(loadRateInput(load), rates);
  // Zlecenie BEZ stawki, dla której cennik ma odpowiedź (np. zapisane przed wprowadzeniem cennika)
  // — mówimy wprost, ile by wyszło i co z tym zrobić. Sama pusta komórka nie podpowiadałaby, że
  // wystarczy kliknąć „Przelicz".
  if (zCennika.suggestion) return `cennik ${zCennika.suggestion.code} dałby ${zCennika.suggestion.amount} zł — kliknij „Przelicz stawki z cennika”`;
  return zCennika.reason ?? "";
}
