// Co dokładnie zapisuje się na zleceniu, gdy dyspozytor położy je na miejscu w Planie wspaniałym.
//
// Plan i Zestawienie to ta sama tabela, więc przypisanie NIE jest osobnym bytem: ustawia pojazd,
// naczepę i kierowcę na zleceniu — dokładnie te pola, które dyspozytor i tak edytuje w Zestawieniu.
// Dzięki temu zmiana w jednym widoku od razu widać w drugim, a dziennik zmian (trigger na `loads`)
// zapisuje ją tak samo jak każdą inną.

import type { Load } from "@/types/load";
import { normalizePlanSlot, refusalReason, type PlanSlot } from "./slots";
import type { PlanRow } from "./planBoard";

export interface AssignTarget {
  row: PlanRow;
  slot: PlanSlot;
  /** Data kolumny: dzień planu dla eksportu, następny dzień roboczy dla importu. */
  day: string;
  /** Kierunek kolumny — kolumny eksportu przyjmują tylko "E", importu tylko "I". */
  direction: "I" | "E";
}

/** Nr dowodu kierowcy z Panelu floty — wstawiany razem z nazwiskiem, jak przy imporcie zlecenia. */
export type DriverDocLookup = (driverName: string) => string;

/**
 * Dlaczego tego zlecenia nie wolno tu położyć — albo null, gdy wolno.
 * Reguła (a) właściciela: kontenera 40/45 nie zabierze solówka.
 */
export function assignRefusal(load: Load, target: AssignTarget): string | null {
  if (load.direction !== target.direction) {
    return target.direction === "E"
      ? "W kolumnach eksportu stoją tylko zlecenia eksportowe."
      : "W kolumnach importu stoją tylko zlecenia importowe.";
  }
  return refusalReason(load.container_size, target.row.vehicleType);
}

/**
 * Zmiany do zapisania na zleceniu. Świadomie NIE nadpisujemy kierowcy ani naczepy, gdy wiersz ich
 * nie zna — dokument bywa mądrzejszy od ustawień planu, a puste ustawienie planu skasowałoby
 * kierowcę odczytanego ze zlecenia.
 */
export function assignmentPatch(load: Load, target: AssignTarget, driverDoc?: DriverDocLookup): Partial<Load> {
  const patch: Partial<Load> = {
    vehicle_plate: target.row.plate,
    plan_slot: normalizePlanSlot(load.container_size, target.slot),
  };

  if (target.row.trailerPlate) patch.trailer_plate = target.row.trailerPlate;
  if (target.row.driverName) {
    patch.driver_name = target.row.driverName;
    const doc = driverDoc?.(target.row.driverName) ?? "";
    if (doc) patch.driver_id_number = doc;
  }
  // Kolumna JEST datą — położenie zlecenia w kolumnie ustawia jego "Datę" w Zestawieniu.
  if (target.day && load.load_date !== target.day) patch.load_date = target.day;

  return patch;
}

/** Zdjęcie zlecenia z planu — wraca do bocznej listy "do zaplanowania". */
export function unassignPatch(): Partial<Load> {
  return { vehicle_plate: null, plan_slot: null };
}
