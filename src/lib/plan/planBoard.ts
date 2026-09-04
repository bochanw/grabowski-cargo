// Ułożenie Planu wspaniałego na jeden dzień — czysta funkcja, bez Reacta i bez bazy.
//
// Kształt widoku wprost z opisu właściciela: pięć kolumn — pojazd+kierowca (+ ładowność pod
// spodem), potem 2 i 3 to EKSPORT z danego dnia roboczego (tył naczepy/przyczepa, potem przód
// naczepy/solówka), a 4 i 5 to IMPORT z NASTĘPNEGO dnia roboczego (analogicznie).
//
// Plan nie ma własnego zbioru danych — czyta `loads` i tylko inaczej je układa ("jedno wynika
// z drugiego"). Zlecenie trafia na wiersz przez `vehicle_plate`, do kolumny przez `direction`
// + `load_date`, a na miejsce przez `plan_slot`.
//
// Dolna linia kafelka eksportu ("po jakim imporcie jest kontener") jest WYLICZANA z planu i
// nadpisywalna ręcznie (`plan_prev_note`) — właściciel wybrał ten wariant wprost. W imporcie tej
// linii nie ma: "import jest prosty, tam są tylko realne ładunki z informacjami o nich".

import type { Load } from "@/types/load";
import type { PlanAbsence, PlanVehicle } from "@/types/plan";
import type { FleetDriver, FleetVehicle } from "@/lib/fleet/fleetStore";
import { normalizePlate, normalizeName } from "@/lib/fleet/fleetStore";
import { nextWorkingDay, previousWorkingDay } from "@/lib/dates/workingDays";
import { PLAN_SLOTS, isPlanSlot, isSolowka, loadOccupiesWholeSet, type PlanSlot } from "./slots";

export interface PlanCell {
  slot: PlanSlot;
  load: Load | null;
  /** 2 = kontener 40/45; kafelek scala obie kolumny wiersza (reguła (b) właściciela). */
  span: 1 | 2;
  /** Miejsce pochłonięte przez scalony kafelek obok — nie rysujemy dla niego komórki. */
  covered: boolean;
  /** Zlecenie stoi tu, bo miejsce było wolne — nikt tego świadomie nie ustawił. */
  slotImplied: boolean;
  /** Dolna linia kafelka eksportu; pusta w imporcie i przy pustym miejscu. */
  memory: string;
  memoryIsManual: boolean;
  /** Zlecenia, dla których zabrakło miejsca — nic nie może zniknąć po cichu. */
  conflicts: Load[];
}

export interface PlanRowAbsence {
  label: string;
  /** "flota" = urlop kierowcy z Panelu floty (tylko do odczytu), "plan" = wpis w tej appce. */
  source: "flota" | "plan";
  absenceId: string | null;
}

/** Jeden dzień planu: kolumny eksportu z tego dnia i importu z następnego dnia roboczego. */
export interface PlanDay {
  dayExport: string;
  dayImport: string;
  /** Przesunięcie względem dnia, na którym stoi plan: -1 wczoraj, 0 dziś, 1 i 2 do przodu. */
  offset: number;
}

/** Ten sam pojazd w jednym dniu okna. */
export interface PlanRowBlock {
  day: PlanDay;
  eksport: PlanCell[];
  import: PlanCell[];
  /** Nieobecności obejmujące AKURAT ten dzień — auto bywa wolne tylko w części okna. */
  absences: PlanRowAbsence[];
}

export interface PlanRow {
  plate: string;
  vehicleType: string;
  trailerPlate: string;
  driverName: string;
  payloadKg: number | null;
  /** Nieobecności z całego okna — to, co stoi w nagłówku wiersza. */
  absences: PlanRowAbsence[];
  /** Pojazd z Panelu floty czy tablica wpisana tylko na zleceniu (podwykonawca, literówka). */
  inFleet: boolean;
  blocks: PlanRowBlock[];
}

export interface PlanBoard {
  days: PlanDay[];
  rows: PlanRow[];
  /** Zlecenia z okna bez pojazdu (oraz te bez daty) — boczna lista "do zaplanowania". */
  unassigned: Load[];
}

export interface PlanBoardInput {
  /** Dzień, na którym stoi plan (offset 0). */
  day: string;
  /** WSZYSTKIE zlecenia — linia "po jakim imporcie" sięga poza wyświetlane dni. */
  loads: Load[];
  fleetVehicles: FleetVehicle[];
  fleetDrivers: FleetDriver[];
  planVehicles: PlanVehicle[];
  absences: PlanAbsence[];
  /** Ile dni roboczych wstecz i w przód pokazać obok dnia bieżącego. */
  daysBefore?: number;
  daysAfter?: number;
}

function emptyCell(slot: PlanSlot): PlanCell {
  return {
    slot,
    load: null,
    span: 1,
    covered: false,
    slotImplied: false,
    memory: "",
    memoryIsManual: false,
    conflicts: [],
  };
}

/**
 * Opis importu w jednej linii — to trafia do kafelka eksportu jako "pamiątka po czym to jest".
 * Kolejność jak w arkuszu klienta: miejscowość, gestia, numer kontenera.
 */
export function describeImportMemory(load: Load): string {
  return [load.city, load.shipping_line, load.container_number]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

/**
 * Import, po którym jedzie ten eksport: NAJPÓŹNIEJSZY import tego samego pojazdu z datą nie
 * późniejszą niż eksport. Ten sam slot ma pierwszeństwo (kontener zdejmuje się z tego miejsca,
 * na które wchodzi następny), a przy remisie decyduje późniejszy zapis.
 *
 * Świadomie bez sięgania w przód: pusty kontener po imporcie, którego jeszcze nie było, nie ma
 * jak stać na dzisiejszym zestawie.
 */
export function findPreviousImport(loads: Load[], plateKey: string, exportLoad: Load): Load | null {
  const exportDate = exportLoad.load_date ?? "";
  if (!exportDate || !plateKey) return null;

  let best: Load | null = null;
  for (const candidate of loads) {
    if (candidate.direction !== "I") continue;
    if (candidate.id === exportLoad.id) continue;
    if (normalizePlate(candidate.vehicle_plate ?? "") !== plateKey) continue;
    const date = candidate.load_date ?? "";
    if (!date || date > exportDate) continue;

    if (best === null) {
      best = candidate;
      continue;
    }
    const bestDate = best.load_date ?? "";
    if (date !== bestDate) {
      if (date > bestDate) best = candidate;
      continue;
    }
    // Ta sama data: najpierw ten z tego samego miejsca, potem zapisany później.
    const candidateSameSlot = candidate.plan_slot === exportLoad.plan_slot;
    const bestSameSlot = best.plan_slot === exportLoad.plan_slot;
    if (candidateSameSlot !== bestSameSlot) {
      if (candidateSameSlot) best = candidate;
      continue;
    }
    if ((candidate.created_at ?? "") > (best.created_at ?? "")) best = candidate;
  }
  return best;
}

/** Urlopy kierowcy z Panelu floty (`drivers[].vacations`) obejmujące podany dzień. */
function fleetVacationLabels(driver: FleetDriver | null, day: string): PlanRowAbsence[] {
  if (!driver) return [];
  return driver.vacations
    .filter((v) => v.startDate && v.endDate && v.startDate <= day && day <= v.endDate)
    .map<PlanRowAbsence>((v) => ({
      label: `Urlop kierowcy (Panel floty): ${v.startDate} – ${v.endDate}`,
      source: "flota",
      absenceId: null,
    }));
}

function planAbsenceLabels(absences: PlanAbsence[], plateKey: string, day: string): PlanRowAbsence[] {
  return absences
    .filter((a) => normalizePlate(a.vehicle_plate) === plateKey && a.start_date <= day && day <= a.end_date)
    .map<PlanRowAbsence>((a) => ({
      label: `${a.reason?.trim() || "Nieobecność"}: ${a.start_date} – ${a.end_date}`,
      source: "plan",
      absenceId: a.id,
    }));
}

/** Stała kolejność zleceń w obrębie wiersza — bez niej układ zależałby od kolejności z bazy. */
function stableOrder(a: Load, b: Load): number {
  return (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id);
}

/**
 * Zlecenia jednego kierunku i dnia rozłożone na dwa miejsca zestawu.
 *
 * Najpierw siadają te z JAWNIE ustawionym miejscem (dyspozytor je tam położył) oraz te zajmujące
 * cały zestaw; dopiero potem reszta wchodzi na wolne miejsca. Zlecenie bez `plan_slot` bierze się
 * z Zestawienia — pojazd wpisał import albo dopasowanie do Panelu floty. Pokazujemy je na wolnym
 * miejscu zamiast chować w bocznej liście: dyspozytor ma zobaczyć, że auto już coś ma.
 */
function layoutSide(sideLoads: Load[], allLoads: Load[], plateKey: string, withMemory: boolean): PlanCell[] {
  const cells: PlanCell[] = PLAN_SLOTS.map(emptyCell);
  const ordered = [...sideLoads].sort(stableOrder);
  const placed = new Set<string>();

  const put = (load: Load, index: number, implied: boolean): boolean => {
    const cell = cells[index];
    if (cell.load) return false;
    cell.load = load;
    cell.span = loadOccupiesWholeSet(load) ? 2 : 1;
    cell.slotImplied = implied;
    placed.add(load.id);
    return true;
  };

  for (const load of ordered) {
    if (loadOccupiesWholeSet(load)) {
      put(load, 0, !isPlanSlot(load.plan_slot));
    } else if (isPlanSlot(load.plan_slot)) {
      put(load, PLAN_SLOTS.indexOf(load.plan_slot), false);
    }
  }
  for (const load of ordered) {
    if (placed.has(load.id)) continue;
    const free = cells.findIndex((cell) => !cell.load);
    if (free >= 0) put(load, free, true);
  }

  // Scalony kafelek pochłania sąsiednie miejsce. Zlecenie, które tam stało, nie znika — ląduje
  // w konfliktach, żeby dyspozytor je zobaczył i przeniósł.
  if (cells[0].span === 2) {
    if (cells[1].load) {
      // Zostaje w `placed` — jest już policzone (w konfliktach), więc pętla niżej go nie powtórzy.
      cells[0].conflicts.push(cells[1].load);
      cells[1].load = null;
    }
    cells[1].covered = true;
  }

  // Co się nie zmieściło (trzeci kontener na zestawie) — pokazujemy przy pierwszym kafelku.
  for (const load of ordered) {
    if (!placed.has(load.id)) cells[0].conflicts.push(load);
  }

  if (withMemory) {
    for (const cell of cells) {
      if (!cell.load) continue;
      const manual = (cell.load.plan_prev_note ?? "").trim();
      if (manual) {
        cell.memory = manual;
        cell.memoryIsManual = true;
      } else {
        const previous = findPreviousImport(allLoads, plateKey, cell.load);
        cell.memory = previous ? describeImportMemory(previous) : "";
      }
    }
  }

  return cells;
}

/**
 * Okno dni, które plan pokazuje naraz (właściciel: "-1 +2, jeden dzień do tyłu i 2 dni do przodu;
 * resztę będziemy zaciągać z archiwum, zależy nam na wygodnej pracy"). Liczone w dniach ROBOCZYCH,
 * nie kalendarzowych — w poniedziałek "dzień do tyłu" to piątek, a nie niedziela.
 */
export const PLAN_DAYS_BEFORE = 1;
export const PLAN_DAYS_AFTER = 2;

export function planWindowDays(day: string, before: number, after: number): PlanDay[] {
  const offsets: string[] = [];
  let cursor = day;
  for (let i = 0; i < before; i++) {
    cursor = previousWorkingDay(cursor);
    offsets.unshift(cursor);
  }
  const wstecz = offsets.map((iso, index) => ({ iso, offset: index - before }));

  const wprzod: { iso: string; offset: number }[] = [];
  cursor = day;
  for (let i = 1; i <= after; i++) {
    cursor = nextWorkingDay(cursor);
    wprzod.push({ iso: cursor, offset: i });
  }

  return [...wstecz, { iso: day, offset: 0 }, ...wprzod].map(({ iso, offset }) => ({
    dayExport: iso,
    dayImport: nextWorkingDay(iso),
    offset,
  }));
}

export function buildPlanBoard(input: PlanBoardInput): PlanBoard {
  const days = planWindowDays(input.day, input.daysBefore ?? PLAN_DAYS_BEFORE, input.daysAfter ?? PLAN_DAYS_AFTER);

  const planByPlate = new Map(input.planVehicles.map((pv) => [normalizePlate(pv.vehicle_plate), pv]));
  const driverByName = new Map(input.fleetDrivers.map((d) => [normalizeName(d.name), d]));

  const belongsTo = (load: Load, day: PlanDay): boolean =>
    (load.direction === "E" && load.load_date === day.dayExport) ||
    (load.direction === "I" && load.load_date === day.dayImport);

  const relevant = input.loads.filter((load) => days.some((day) => belongsTo(load, day)));

  // Zlecenia BEZ daty ("Bez daty" w Zestawieniu — dokument jej nie podał albo nikt jej nie ustawił)
  // nie należą do żadnego dnia, więc nie wejdą do żadnej kolumny. Bez tego byłyby w planie
  // niewidoczne: dyspozytor nie zobaczyłby pracy, o której appka wie. Trafiają do bocznej listy,
  // a położenie ich na miejscu USTAWIA datę kolumny.
  const dateless = input.loads.filter((load) => !load.load_date && !normalizePlate(load.vehicle_plate ?? ""));

  // Wiersze: wszystkie auta z Panelu floty (właściciel: "wszystkie auta"), plus tablice, które
  // pojawiły się na zleceniach, a floty nie ma — inaczej zaplanowane zlecenie zniknęłoby z widoku.
  const rowPlates: { plate: string; type: string; trailer: string; payload: number | null; inFleet: boolean }[] = [];
  const seen = new Set<string>();
  for (const vehicle of input.fleetVehicles) {
    const key = normalizePlate(vehicle.plate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rowPlates.push({
      plate: vehicle.plate,
      type: vehicle.type,
      trailer: vehicle.assignedTrailerPlate,
      payload: vehicle.payloadKg,
      inFleet: true,
    });
  }
  for (const load of relevant) {
    const plate = (load.vehicle_plate ?? "").trim();
    const key = normalizePlate(plate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rowPlates.push({ plate, type: "", trailer: (load.trailer_plate ?? "").trim(), payload: null, inFleet: false });
  }

  const rows: PlanRow[] = rowPlates.map(({ plate, type, trailer, payload, inFleet }) => {
    const key = normalizePlate(plate);
    const planVehicle = planByPlate.get(key) ?? null;
    const mine = relevant.filter((load) => normalizePlate(load.vehicle_plate ?? "") === key);

    // Kierowca: etatowy z ustawień planu, a gdy go nie ma — ten wpisany na zleceniach z okna.
    // Panel floty nie wiąże kierowcy z pojazdem, więc innego źródła nie ma.
    const driverName =
      planVehicle?.driver_name?.trim() || mine.map((l) => (l.driver_name ?? "").trim()).find(Boolean) || "";
    const driver = driverByName.get(normalizeName(driverName)) ?? null;

    const blocks: PlanRowBlock[] = days.map((day) => {
      const tego = mine.filter((load) => belongsTo(load, day));
      return {
        day,
        eksport: layoutSide(tego.filter((l) => l.direction === "E"), input.loads, key, true),
        import: layoutSide(tego.filter((l) => l.direction === "I"), input.loads, key, false),
        absences: [
          ...planAbsenceLabels(input.absences, key, day.dayExport),
          ...fleetVacationLabels(driver, day.dayExport),
        ],
      };
    });

    // Nagłówek wiersza pokazuje nieobecności z całego okna, bez powtórek — auto bywa wolne tylko
    // w części dni, a etykieta i tak niesie zakres dat.
    const byLabel = new Map<string, PlanRowAbsence>();
    for (const block of blocks) for (const absence of block.absences) byLabel.set(absence.label, absence);

    return {
      plate,
      vehicleType: type,
      trailerPlate: trailer || mine.map((l) => (l.trailer_plate ?? "").trim()).find(Boolean) || "",
      driverName,
      // Ładowność: wpis w planie wygrywa z Panelem floty (dyspozytor poprawia konkretne auto),
      // a gdy nikt nic nie wpisał — wartość z floty, jeśli to pole tam już jest.
      payloadKg: planVehicle?.payload_kg ?? payload,
      absences: [...byLabel.values()],
      inFleet,
      blocks,
    };
  });

  // Auto ukryte w ustawieniach planu znika z widoku, ale NIE wtedy, gdy coś na nim stoi —
  // ukrycie nie może chować pracy.
  const visible = rows.filter((row) => {
    const planVehicle = planByPlate.get(normalizePlate(row.plate));
    if (!planVehicle?.hidden) return true;
    return row.blocks.some((block) => block.eksport.some((c) => c.load) || block.import.some((c) => c.load));
  });

  const positionOf = (row: PlanRow): number =>
    planByPlate.get(normalizePlate(row.plate))?.position ?? Number.MAX_SAFE_INTEGER;

  visible.sort((a, b) => {
    const byPosition = positionOf(a) - positionOf(b);
    if (byPosition !== 0) return byPosition;
    if (a.inFleet !== b.inFleet) return a.inFleet ? -1 : 1;
    return a.plate.localeCompare(b.plate, "pl");
  });

  const unassigned = [...relevant.filter((load) => !normalizePlate(load.vehicle_plate ?? "")), ...dateless].sort(
    stableOrder
  );

  return { days, rows: visible, unassigned };
}

/** Czy pojazd wiersza to solówka (nie weźmie 40/45) — używane przy podświetlaniu celu upuszczenia. */
export function rowIsSolowka(row: PlanRow): boolean {
  return isSolowka(row.vehicleType);
}
