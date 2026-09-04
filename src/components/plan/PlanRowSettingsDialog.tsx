"use client";

import { useState } from "react";
import type { FleetDriver } from "@/lib/fleet/fleetStore";
import { withCurrentOption } from "@/lib/fleet/fleetStore";
import type { PlanAbsence } from "@/types/plan";
import type { PlanRow } from "@/lib/plan/planBoard";
import { normalizePlate } from "@/lib/fleet/fleetStore";
import { useDeletePlanAbsence, useSavePlanAbsence, useSavePlanVehicle } from "@/hooks/usePlan";
import { todayIso } from "@/lib/dates/workingDays";

/**
 * Ustawienia jednego wiersza planu: kierowca etatowy, ładowność, ukrycie auta i nieobecności.
 *
 * Kierowca i ładowność nie mają skąd wziąć się same — Panel floty nie wiąże kierowcy z pojazdem,
 * a pola ładowności jeszcze tam nie ma (właściciel zapowiedział jego dodanie; gdy się pojawi,
 * appka bierze wartość stamtąd, a wpis tutaj zostaje nadpisaniem).
 *
 * Urlopy kierowców z Panelu floty są tu WIDOCZNE, ale nie do edycji — źródłem prawdy zostaje
 * Panel floty i nigdy do niego nie piszemy.
 */
export function PlanRowSettingsDialog({
  row,
  drivers,
  absences,
  onClose,
}: {
  row: PlanRow;
  drivers: FleetDriver[];
  absences: PlanAbsence[];
  onClose: () => void;
}) {
  const savePlanVehicle = useSavePlanVehicle();
  const saveAbsence = useSavePlanAbsence();
  const deleteAbsence = useDeletePlanAbsence();

  const [driverName, setDriverName] = useState(row.driverName);
  const [payload, setPayload] = useState(row.payloadKg === null ? "" : String(row.payloadKg));
  const [ukryty, setUkryty] = useState(row.hidden);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [absenceFrom, setAbsenceFrom] = useState(todayIso);
  const [absenceTo, setAbsenceTo] = useState(todayIso);
  const [absenceReason, setAbsenceReason] = useState("Urlop");

  const plateKey = normalizePlate(row.plate);
  const mine = absences.filter((a) => normalizePlate(a.vehicle_plate) === plateKey);
  const fleetVacations = row.absences.filter((a) => a.source === "flota");

  const saveRow = async () => {
    setSaving(true);
    const parsed = payload.trim() === "" ? null : Number(payload.replace(/\s/g, "").replace(",", "."));
    if (parsed !== null && !Number.isFinite(parsed)) {
      setError("Ładowność musi być liczbą kilogramów.");
      setSaving(false);
      return;
    }
    const err = await savePlanVehicle(row.plate, {
      driver_name: driverName.trim() || null,
      payload_kg: parsed,
      hidden: ukryty,
    });
    setSaving(false);
    if (err) setError(err);
    else onClose();
  };

  const addAbsence = async () => {
    if (absenceTo < absenceFrom) {
      setError("Data końca nie może być wcześniejsza niż początek.");
      return;
    }
    const err = await saveAbsence({
      vehicle_plate: row.plate,
      start_date: absenceFrom,
      end_date: absenceTo,
      reason: absenceReason.trim() || null,
    });
    if (err) setError(err);
    else setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded border border-zinc-300 bg-white p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="mb-3 text-base font-semibold">
          {row.plate} {row.trailerPlate && <span className="font-normal text-zinc-500">· nacz. {row.trailerPlate}</span>}
        </h2>

        {error && (
          <p className="mb-3 rounded bg-red-100 px-2 py-1 text-red-800 dark:bg-red-950 dark:text-red-200">{error}</p>
        )}

        <label className="mb-1 block text-xs text-zinc-500">Kierowca etatowy</label>
        <select
          value={driverName}
          onChange={(event) => setDriverName(event.target.value)}
          className="mb-3 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">— brak —</option>
          {withCurrentOption(drivers.map((d) => d.name), driverName).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs text-zinc-500">
          Ładowność (kg) — docelowo z Panelu floty, do tego czasu wpisywana tutaj
        </label>
        <input
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          inputMode="numeric"
          placeholder="np. 24000"
          className="mb-4 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        />

        <label className="mb-4 flex items-center gap-2">
          <input type="checkbox" checked={ukryty} onChange={(event) => setUkryty(event.target.checked)} />
          <span>
            Ukryj to auto w planie
            <span className="block text-xs text-zinc-500">
              Wiersz i tak wróci w dniu, w którym coś na nim stoi — ukrycie nie chowa pracy.
            </span>
          </span>
        </label>

        <div className="mb-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700">
            Zamknij
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveRow()}
            className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {saving ? "Zapisuję…" : "Zapisz"}
          </button>
        </div>

        <hr className="my-4 border-zinc-200 dark:border-zinc-800" />

        <h3 className="mb-2 font-semibold">Nieobecności</h3>
        {fleetVacations.length > 0 && (
          <ul className="mb-2 space-y-1 text-xs text-amber-700 dark:text-amber-400">
            {fleetVacations.map((v) => (
              <li key={v.label}>{v.label} — z Panelu floty, zmiana po tamtej stronie</li>
            ))}
          </ul>
        )}
        <ul className="mb-3 space-y-1 text-xs">
          {mine.length === 0 && <li className="text-zinc-500">Brak wpisów w tej appce.</li>}
          {mine.map((absence) => (
            <li key={absence.id} className="flex items-center justify-between gap-2">
              <span>
                {absence.reason || "Nieobecność"}: {absence.start_date} – {absence.end_date}
              </span>
              <button
                type="button"
                onClick={() => void deleteAbsence(absence.id)}
                className="rounded border border-zinc-300 px-1 text-zinc-500 hover:text-red-600 dark:border-zinc-700"
              >
                usuń
              </button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs text-zinc-500">Od</label>
            <input
              type="date"
              value={absenceFrom}
              onChange={(event) => setAbsenceFrom(event.target.value)}
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500">Do</label>
            <input
              type="date"
              value={absenceTo}
              onChange={(event) => setAbsenceTo(event.target.value)}
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-zinc-500">Powód</label>
            <input
              value={absenceReason}
              onChange={(event) => setAbsenceReason(event.target.value)}
              placeholder="Urlop / awaria / serwis"
              className="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <button
            type="button"
            onClick={() => void addAbsence()}
            className="rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Dodaj
          </button>
        </div>
      </div>
    </div>
  );
}
