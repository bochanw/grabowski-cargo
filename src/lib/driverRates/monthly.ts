// Miesięczne zestawienie stawek kierowców (właściciel: "potem pozwoli łatwo w skali miesiąca
// pokazać stawki kierowcy w zestawieniu"). Czysta agregacja nad tymi samymi `loads`, które widzi
// Zestawienie i Plan wspaniały — bez własnego zbioru danych, więc poprawka stawki w tabeli jest
// widoczna tutaj natychmiast (ten sam cache TanStack Query odświeżany przez Realtime).

import type { Load } from "@/types/load";

/** Zlecenie bez daty — osobna „szuflada", żeby nie zniknęło z żadnego miesiąca. */
export const BEZ_DATY = "bez-daty";

const MIESIACE = [
  "styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
  "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień",
];

/**
 * Miesiąc zlecenia liczymy po kolumnie „Data" (`load_date`) — to dzień, na który zlecenie jest
 * zaplanowane i po którym dyspozytorzy układają tydzień. Data rozładunku (`secondary_date`) bywa
 * w kolejnym miesiącu, ale kierowca jedzie w dniu z „Daty".
 */
export function monthKeyOf(load: Pick<Load, "load_date">): string {
  const date = (load.load_date ?? "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(date) ? date : BEZ_DATY;
}

export function formatMonth(key: string): string {
  if (key === BEZ_DATY) return "Bez daty";
  const [rok, miesiac] = key.split("-");
  const index = Number(miesiac) - 1;
  return index >= 0 && index < 12 ? `${MIESIACE[index]} ${rok}` : key;
}

/** Miesiące, w których cokolwiek stoi — od najnowszego; „bez daty" zawsze na końcu. */
export function availableMonths(loads: Load[]): string[] {
  const keys = new Set(loads.map(monthKeyOf));
  const zDatami = [...keys].filter((key) => key !== BEZ_DATY).sort().reverse();
  return keys.has(BEZ_DATY) ? [...zDatami, BEZ_DATY] : zDatami;
}

export interface DriverMonthRow {
  /** Puste = zlecenie bez przypisanego kierowcy. */
  driver: string;
  loads: Load[];
  /** Suma stawek; zlecenia bez stawki liczą się jako 0 i są policzone osobno. */
  total: number;
  withoutRate: number;
  manual: number;
}

export interface MonthlySummary {
  rows: DriverMonthRow[];
  total: number;
  loadsCount: number;
  withoutRate: number;
}

/**
 * Zlecenia miesiąca pogrupowane po kierowcy. Kierowcy alfabetycznie, a zlecenia bez kierowcy na
 * końcu jako osobny wiersz — nie chowamy ich: to zwykle po prostu jeszcze nieobsadzone zlecenia,
 * a ich stawki i tak zostaną wypłacone.
 */
export function summarizeMonth(loads: Load[], month: string): MonthlySummary {
  const wMiesiacu = loads.filter((load) => monthKeyOf(load) === month);
  const grupy = new Map<string, Load[]>();
  for (const load of wMiesiacu) {
    const driver = (load.driver_name ?? "").trim();
    const lista = grupy.get(driver);
    if (lista) lista.push(load);
    else grupy.set(driver, [load]);
  }

  const rows: DriverMonthRow[] = [...grupy.entries()]
    .map(([driver, lista]) => ({
      driver,
      loads: [...lista].sort((a, b) => (a.load_date ?? "").localeCompare(b.load_date ?? "")),
      total: lista.reduce((sum, load) => sum + (load.driver_rate ?? 0), 0),
      withoutRate: lista.filter((load) => load.driver_rate === null).length,
      manual: lista.filter((load) => load.driver_rate_source === "manual").length,
    }))
    .sort((a, b) => {
      if (a.driver === "") return 1;
      if (b.driver === "") return -1;
      return a.driver.localeCompare(b.driver, "pl");
    });

  return {
    rows,
    total: rows.reduce((sum, row) => sum + row.total, 0),
    loadsCount: wMiesiacu.length,
    withoutRate: rows.reduce((sum, row) => sum + row.withoutRate, 0),
  };
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV do rozliczenia poza appką (Excel właściciela). Separator to średnik, bo polski Excel dzieli
 * po nim; liczby z przecinkiem dziesiętnym z tego samego powodu.
 */
export function monthlyCsv(summary: MonthlySummary, month: string): string {
  const linie = [["Kierowca", "Data", "Nr zlecenia", "Kierunek", "Miejscowość", "Kod pocztowy", "Stawka (zł)", "Skąd stawka"].join(";")];
  for (const row of summary.rows) {
    for (const load of row.loads) {
      linie.push(
        [
          csvCell(row.driver || "(bez kierowcy)"),
          csvCell(load.load_date),
          csvCell(load.order_number),
          csvCell(load.direction),
          csvCell(load.city),
          csvCell(load.postal_code),
          csvCell(load.driver_rate === null ? "" : String(load.driver_rate).replace(".", ",")),
          csvCell(load.driver_rate_source === "manual" ? "ręcznie" : load.driver_rate_code ? `cennik ${load.driver_rate_code}` : ""),
        ].join(";")
      );
    }
    linie.push([csvCell(`RAZEM ${row.driver || "(bez kierowcy)"}`), "", "", "", "", "", csvCell(String(row.total).replace(".", ",")), ""].join(";"));
  }
  linie.push([csvCell(`RAZEM ${formatMonth(month)}`), "", "", "", "", "", csvCell(String(summary.total).replace(".", ",")), ""].join(";"));
  return linie.join("\n");
}
