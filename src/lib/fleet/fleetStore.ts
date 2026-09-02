import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { ParsedOrder } from "@/types/parsedOrder";
import type { Load } from "@/types/load";

// Kierowca, nr dowodu, ciągnik i naczepa NIE są dowolnym tekstem (właściciel): mają pochodzić z
// Panelu floty tego samego klienta — ten sam projekt Supabase, tabela `fleet_store` (klucz → JSON
// blob, wzorzec appki floty, patrz CLAUDE.md "Wzorzec danych"). Czytamy TYLKO trzy klucze objęte
// polityką "flota - manager i pracownik" (każdy zalogowany): `vehicles`, `drivers`,
// `driver_documents`. Nigdy tu nie zapisujemy — źródłem prawdy o flocie zostaje Panel floty.
//
// Kształty rekordów skopiowane z bochanw/DAB/templates/src (11-flota-pojazdy-kierowcy.js,
// 13-flota-zaswiadczenie.js): pojazd {id, brand, type: 'ciagnik'|'naczepa'|'solowka', plate,
// plateB (naczepa podkontenerowa — drugi dowód), assignedTrailerPlate}, kierowca {id, name, ...daty
// ważności}, dokument kierowcy {driverId, docNumber} (nr dowodu/paszportu/prawa jazdy). Panel floty
// NIE MA telefonu kierowcy — telefon zostaje z dokumentu zlecenia albo z poprzedniego zlecenia.

export interface FleetVehicle {
  id: string;
  plate: string;
  plateB: string;
  brand: string;
  type: string;
  assignedTrailerPlate: string;
}

export interface FleetDriver {
  id: string;
  name: string;
  docNumber: string;
}

export interface Fleet {
  tractors: FleetVehicle[]; // ciągniki + solówki — wszystko, co ciągnie
  trailers: FleetVehicle[];
  drivers: FleetDriver[];
}

export const EMPTY_FLEET: Fleet = { tractors: [], trailers: [], drivers: [] };

// Ta sama normalizacja co w Panelu floty (normalizePlateRaw/normalizeName w
// 21-rent-narzedzia-parsery.js) — bez aliasów literówek (plate_aliases), tych appka ładunków nie czyta.
export function normalizePlate(plate: string): string {
  return (plate || "").toUpperCase().replace(/[\s-]/g, "").trim();
}

const PL_MAP: Record<string, string> = {
  ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z",
  Ą: "A", Ć: "C", Ę: "E", Ł: "L", Ń: "N", Ó: "O", Ś: "S", Ź: "Z", Ż: "Z",
};

export function normalizeName(name: string): string {
  return (name || "")
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (ch) => PL_MAP[ch] ?? ch)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

async function fetchFleet(): Promise<Fleet> {
  const { data, error } = await supabase
    .from("fleet_store")
    .select("key,value")
    .in("key", ["vehicles", "drivers", "driver_documents"]);
  if (error) throw error;

  const byKey = new Map<string, unknown>((data ?? []).map((row) => [row.key as string, row.value]));
  const vehicles = asArray(byKey.get("vehicles")).map<FleetVehicle>((v) => ({
    id: str(v.id),
    plate: str(v.plate),
    plateB: str(v.plateB),
    brand: str(v.brand),
    type: str(v.type),
    assignedTrailerPlate: str(v.assignedTrailerPlate),
  }));
  const docByDriver = new Map(asArray(byKey.get("driver_documents")).map((d) => [str(d.driverId), str(d.docNumber)]));
  const drivers = asArray(byKey.get("drivers")).map<FleetDriver>((d) => ({
    id: str(d.id),
    name: str(d.name),
    docNumber: docByDriver.get(str(d.id)) ?? "",
  }));

  return {
    tractors: vehicles.filter((v) => v.type !== "naczepa" && v.plate),
    trailers: vehicles.filter((v) => v.type === "naczepa" && v.plate),
    drivers: drivers.filter((d) => d.name),
  };
}

export function useFleet() {
  return useQuery({ queryKey: ["fleet"], queryFn: fetchFleet, staleTime: 5 * 60 * 1000 });
}

export function findVehicle(list: FleetVehicle[], plate: string): FleetVehicle | null {
  const key = normalizePlate(plate);
  if (!key) return null;
  return list.find((v) => normalizePlate(v.plate) === key || (v.plateB && normalizePlate(v.plateB) === key)) ?? null;
}

export function findDriver(drivers: FleetDriver[], name: string): FleetDriver | null {
  const key = normalizeName(name);
  if (!key) return null;
  return drivers.find((d) => normalizeName(d.name) === key) ?? null;
}

type FleetField = "driver_name" | "driver_id_number" | "driver_phone" | "vehicle_plate" | "trailer_plate";

// Najnowsze zlecenie z wypełnionym polem — `recentLoads` posortowane od najnowszego.
function previousValue(recentLoads: Load[], key: FleetField): string {
  for (const load of recentLoads) {
    const value = load[key];
    if (value) return value;
  }
  return "";
}

/**
 * Dopasowuje kierowcę/pojazdy z dokumentu do Panelu floty. Reguła właściciela: te pola to nie
 * dowolne wartości — (1) dopasuj do floty, (2) jak się nie uda, weź z poprzedniego zlecenia.
 * Wartość z dokumentu nigdy nie ginie po cichu: każde odstępstwo ląduje w `warnings`, a formularz
 * pokazuje ją jako opcję "spoza panelu floty", żeby dało się ją jednym kliknięciem przywrócić.
 */
export function reconcileWithFleet(
  parsed: ParsedOrder,
  fleet: Fleet,
  recentLoads: Load[]
): { order: ParsedOrder; warnings: string[] } {
  const order = { ...parsed };
  const warnings: string[] = [];

  // Kierowca: nazwisko z floty jest kanoniczne; nr dowodu z `driver_documents`, jeśli jest.
  if (order.driver_name) {
    const driver = findDriver(fleet.drivers, order.driver_name);
    if (driver) {
      order.driver_name = driver.name;
      if (driver.docNumber) {
        if (order.driver_id_number && order.driver_id_number !== driver.docNumber) {
          warnings.push(`Nr dowodu kierowcy: dokument podaje ${order.driver_id_number}, Panel floty ${driver.docNumber} — użyto wartości z Panelu floty.`);
        }
        order.driver_id_number = driver.docNumber;
      }
    } else {
      const previous = previousValue(recentLoads, "driver_name");
      if (previous) {
        warnings.push(`Kierowca "${order.driver_name}" z dokumentu nie występuje w Panelu floty — podstawiono z poprzedniego zlecenia: ${previous}. Wartość z dokumentu jest dostępna na liście.`);
        order.driver_name = previous;
        order.driver_id_number = previousValue(recentLoads, "driver_id_number");
        if (!order.driver_phone) order.driver_phone = previousValue(recentLoads, "driver_phone");
      } else {
        warnings.push(`Kierowca "${order.driver_name}" z dokumentu nie występuje w Panelu floty — sprawdź.`);
      }
    }
  } else {
    const previous = previousValue(recentLoads, "driver_name");
    if (previous) {
      order.driver_name = previous;
      if (!order.driver_id_number) order.driver_id_number = previousValue(recentLoads, "driver_id_number");
      if (!order.driver_phone) order.driver_phone = previousValue(recentLoads, "driver_phone");
      warnings.push(`Brak kierowcy w dokumencie — podstawiono z poprzedniego zlecenia: ${previous}.`);
    }
  }
  if (!order.driver_phone) order.driver_phone = previousValue(recentLoads, "driver_phone");

  // Ciągnik / naczepa: tablica z floty jest kanoniczna (dokument bywa bez spacji/myślników).
  const reconcilePlate = (key: "vehicle_plate" | "trailer_plate", list: FleetVehicle[], label: string): FleetVehicle | null => {
    if (order[key]) {
      const vehicle = findVehicle(list, order[key]);
      if (vehicle) {
        order[key] = vehicle.plate;
        return vehicle;
      }
      const previous = previousValue(recentLoads, key);
      if (previous) {
        warnings.push(`${label} ${order[key]} z dokumentu nie występuje w Panelu floty — podstawiono z poprzedniego zlecenia: ${previous}. Wartość z dokumentu jest dostępna na liście.`);
        order[key] = previous;
      } else {
        warnings.push(`${label} ${order[key]} z dokumentu nie występuje w Panelu floty — sprawdź.`);
      }
      return null;
    }
    const previous = previousValue(recentLoads, key);
    if (previous) {
      order[key] = previous;
      warnings.push(`Brak pola "${label}" w dokumencie — podstawiono z poprzedniego zlecenia: ${previous}.`);
    }
    return null;
  };

  const tractor = reconcilePlate("vehicle_plate", fleet.tractors, "Pojazd");
  reconcilePlate("trailer_plate", fleet.trailers, "Naczepa");
  // Stała naczepa z Panelu floty — tylko gdy dokument i poprzednie zlecenie nic nie dały.
  if (!order.trailer_plate && tractor?.assignedTrailerPlate) {
    order.trailer_plate = tractor.assignedTrailerPlate;
    warnings.push(`Naczepa ${tractor.assignedTrailerPlate} z przypisania do ciągnika ${tractor.plate} w Panelu floty.`);
  }

  return { order, warnings };
}

/** Opcje listy: wartości z floty + bieżąca wartość spoza listy (żeby nic nie zginęło). */
export function withCurrentOption(options: string[], current: string): { value: string; label: string }[] {
  const result = options.map((value) => ({ value, label: value }));
  if (current && !options.includes(current)) result.push({ value: current, label: `${current} (spoza Panelu floty)` });
  return result;
}
