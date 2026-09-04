// Odwzorowanie tabel z supabase/migrations/0025_plan_wspanialy.sql.

/** Dane wiersza planu, których Panel floty nie ma (kierowca etatowy, ładowność, kolejność). */
export interface PlanVehicle {
  vehicle_plate: string;
  driver_name: string | null;
  payload_kg: number | null;
  position: number | null;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

/** Nieobecność pojazdu: urlop wpisany u nas, awaria, serwis. Urlopy kierowców z floty czytamy osobno. */
export interface PlanAbsence {
  id: string;
  vehicle_plate: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  created_at: string;
}
