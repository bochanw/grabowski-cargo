"use client";

import { useMemo, useState } from "react";
import { useDeleteDriverRate, useDriverRates, useSaveDriverRate } from "@/hooks/useDriverRates";
import { formatRatePrefix, type DriverRateRow } from "@/lib/driverRates/rates";
import { normalizeSearchText } from "@/lib/search/loadSearch";

const PUSTY: DriverRateRow = { prefix: "", city: "", rate_to_15t: 0, rate_over_15t: 0, rate_over_22t: 0 };

/**
 * Cennik stawek (`driver_rates`, migracja 0030) — podgląd i poprawianie wprost w appce.
 *
 * Dlaczego w ogóle edytowalny: stawki się zmieniają, a wtedy zmiana ma być kliknięciem, nie
 * wdrożeniem ani wklejaniem SQL-a w Dashboardzie. Prefiks („06-1") jest kluczem w bazie, więc przy
 * istniejącym wierszu jest tylko do odczytu — zmiana kodu to nowy wiersz i skasowanie starego,
 * a nie ciche przepisanie klucza pod stawkami, które ktoś już podpiął do zleceń.
 */
export function CennikPanel({ onClose }: { onClose: () => void }) {
  const { data: rates = [] } = useDriverRates();
  const saveRate = useSaveDriverRate();
  const deleteRate = useDeleteDriverRate();
  const [szukaj, setSzukaj] = useState("");
  const [nowy, setNowy] = useState<DriverRateRow>(PUSTY);
  const [blad, setBlad] = useState<string | null>(null);

  const widoczne = useMemo(() => {
    const potrzebne = normalizeSearchText(szukaj);
    if (!potrzebne) return rates;
    // Cyfry porównujemy osobno, ale TYLKO gdy zapytanie w ogóle jakieś ma: puste `cyfry` znaczyłyby
    // `startsWith("")`, czyli „pasuje każdy wiersz" — wtedy szukanie po nazwie miasta nic nie zawęża
    // (złapane testem w przeglądarce, nie przy pisaniu).
    const cyfry = szukaj.replace(/\D/g, "");
    return rates.filter(
      (row) =>
        (cyfry !== "" && (formatRatePrefix(row.prefix).includes(szukaj.trim()) || row.prefix.startsWith(cyfry))) ||
        normalizeSearchText(row.city ?? "").includes(potrzebne)
    );
  }, [rates, szukaj]);

  async function zapisz(row: DriverRateRow, patch: Partial<DriverRateRow>) {
    setBlad(await saveRate({ ...row, ...patch }));
  }

  async function dodaj() {
    const prefix = nowy.prefix.replace(/\D/g, "");
    if (prefix.length < 2 || prefix.length > 3) {
      setBlad("Kod w cenniku to 2 cyfry (06) albo 3 (06-1) — tak jak w arkuszu.");
      return;
    }
    const error = await saveRate({ ...nowy, prefix });
    setBlad(error);
    if (!error) setNowy(PUSTY);
  }

  return (
    <aside className="flex w-[30rem] min-h-0 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="text-sm font-semibold">Cennik stawek</span>
        <input
          value={szukaj}
          onChange={(e) => setSzukaj(e.target.value)}
          placeholder="kod albo miejscowość"
          className="w-40 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
        <span className="text-xs text-zinc-500">{widoczne.length} z {rates.length}</span>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-zinc-500 hover:underline">
          Zamknij
        </button>
      </div>

      {blad && <p className="border-b border-zinc-200 bg-red-50 px-3 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">{blad}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-100 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-2 py-1">Kod</th>
              <th className="px-2 py-1">Miejscowość</th>
              <th className="px-2 py-1 text-right">do 15t</th>
              <th className="px-2 py-1 text-right">pow. 15t</th>
              <th className="px-2 py-1 text-right">pow. 22t</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {widoczne.map((row) => (
              <tr key={row.prefix} data-testid="wiersz-cennika" className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="px-2 py-1 font-mono">{formatRatePrefix(row.prefix)}</td>
                <td className="px-2 py-1 text-zinc-600 dark:text-zinc-400">{row.city}</td>
                {(["rate_to_15t", "rate_over_15t", "rate_over_22t"] as const).map((key) => (
                  <td key={key} className="px-1 py-0.5">
                    <input
                      type="number"
                      step="any"
                      defaultValue={row[key]}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isFinite(value) && value !== row[key]) void zapisz(row, { [key]: value });
                      }}
                      className="w-16 rounded border border-transparent px-1 py-0.5 text-right hover:border-zinc-300 focus:border-zinc-400 dark:bg-transparent dark:hover:border-zinc-700"
                    />
                  </td>
                ))}
                <td className="px-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Usunąć z cennika kod ${formatRatePrefix(row.prefix)}?`)) void deleteRate(row.prefix);
                    }}
                    className="px-1 text-zinc-400 hover:text-red-600"
                    title="Usuń wiersz cennika"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-1 border-t border-zinc-200 px-2 py-2 text-xs dark:border-zinc-800">
        <input
          value={nowy.prefix}
          onChange={(e) => setNowy({ ...nowy, prefix: e.target.value })}
          placeholder="kod, np. 08-6"
          className="w-24 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          value={nowy.city ?? ""}
          onChange={(e) => setNowy({ ...nowy, city: e.target.value })}
          placeholder="miejscowość"
          className="w-32 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {(["rate_to_15t", "rate_over_15t", "rate_over_22t"] as const).map((key) => (
          <input
            key={key}
            type="number"
            step="any"
            value={nowy[key]}
            onChange={(e) => setNowy({ ...nowy, [key]: Number(e.target.value) })}
            className="w-16 rounded border border-zinc-300 px-2 py-1 text-right dark:border-zinc-700 dark:bg-zinc-900"
          />
        ))}
        <button type="button" onClick={dodaj} className="rounded-full border border-zinc-900 bg-zinc-900 px-3 py-1 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900">
          Dodaj kod
        </button>
      </div>
    </aside>
  );
}
