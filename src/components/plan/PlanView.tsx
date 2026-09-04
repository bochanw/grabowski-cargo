"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import type { Load } from "@/types/load";
import { useLoads, useUpdateLoad } from "@/hooks/useLoads";
import { useFleet, EMPTY_FLEET, findDriver } from "@/lib/fleet/fleetStore";
import { usePlanAbsences, usePlanVehicles } from "@/hooks/usePlan";
import {
  buildPlanBoard,
  PLAN_DAYS_AFTER,
  PLAN_DAYS_BEFORE,
  type PlanBoard,
  type PlanCell,
  type PlanDay,
  type PlanRow,
  type PlanRowBlock,
} from "@/lib/plan/planBoard";
import { PLAN_SLOTS, PLAN_SLOT_LABELS, type PlanSlot } from "@/lib/plan/slots";
import { assignRefusal, assignmentPatch, unassignPatch } from "@/lib/plan/assign";
import { nextWorkingDay, previousWorkingDay, todayIso, isWorkingDay } from "@/lib/dates/workingDays";
import { PlanTile } from "./PlanTile";
import { PlanRowSettingsDialog } from "./PlanRowSettingsDialog";

const DAY_FORMATTER = new Intl.DateTimeFormat("pl-PL", { weekday: "long", day: "2-digit", month: "2-digit" });
const SHORT_DAY_FORMATTER = new Intl.DateTimeFormat("pl-PL", { weekday: "short", day: "2-digit", month: "2-digit" });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY_FORMATTER.format(parsed);
}

function formatShortDay(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? iso : SHORT_DAY_FORMATTER.format(parsed);
}

/** Dzień startowy: dziś, a w weekend/święto najbliższy dzień roboczy — planu i tak nikt nie robi na niedzielę. */
function defaultDay(): string {
  const today = todayIso();
  return isWorkingDay(today) ? today : nextWorkingDay(today);
}

interface DropTarget {
  row: PlanRow;
  slot: PlanSlot;
  direction: "I" | "E";
  day: string;
}

export function PlanView() {
  const { data: loads, isLoading, isError, error } = useLoads();
  const { data: fleet } = useFleet();
  const { data: planVehicles } = usePlanVehicles();
  const { data: absences } = usePlanAbsences();
  const updateLoad = useUpdateLoad();

  const [day, setDay] = useState(defaultDay);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: "info" | "error" } | null>(null);
  const [settingsRow, setSettingsRow] = useState<PlanRow | null>(null);
  const [memoryEdit, setMemoryEdit] = useState<{ load: Load; value: string } | null>(null);
  // Cztery dni razy kilkadziesiąt aut to długa lista — przełącznik dla dyspozytora, który
  // chce zobaczyć samą pracę. Domyślnie WYŁĄCZONY: właściciel prosił o "wszystkie auta",
  // bo z pustych wierszy widać wolne moce.
  const [tylkoZajete, setTylkoZajete] = useState(false);

  const board: PlanBoard = useMemo(
    () =>
      buildPlanBoard({
        day,
        loads: loads ?? [],
        fleetVehicles: (fleet ?? EMPTY_FLEET).tractors,
        fleetDrivers: (fleet ?? EMPTY_FLEET).drivers,
        planVehicles: planVehicles ?? [],
        absences: absences ?? [],
      }),
    [day, loads, fleet, planVehicles, absences]
  );

  const loadsById = useMemo(() => new Map((loads ?? []).map((l) => [l.id, l])), [loads]);
  const selected = selectedId ? loadsById.get(selectedId) ?? null : null;

  const driverDoc = useCallback(
    (name: string) => findDriver((fleet ?? EMPTY_FLEET).drivers, name)?.docNumber ?? "",
    [fleet]
  );

  const place = useCallback(
    async (load: Load, target: DropTarget) => {
      const refusal = assignRefusal(load, target);
      if (refusal) {
        setMessage({ text: refusal, kind: "error" });
        return;
      }
      setMessage(null);
      setSelectedId(null);
      const patch = assignmentPatch(load, target, driverDoc);
      const err = await updateLoad(load.id, patch);
      if (err) setMessage({ text: `Nie udało się zapisać: ${err}`, kind: "error" });
    },
    [driverDoc, updateLoad]
  );

  const remove = useCallback(
    async (load: Load) => {
      setSelectedId(null);
      const err = await updateLoad(load.id, unassignPatch());
      if (err) setMessage({ text: `Nie udało się zdjąć z planu: ${err}`, kind: "error" });
    },
    [updateLoad]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent, target: DropTarget) => {
      event.preventDefault();
      const id = event.dataTransfer.getData("text/plain");
      const load = loadsById.get(id);
      if (load) void place(load, target);
    },
    [loadsById, place]
  );

  const saveMemory = useCallback(async () => {
    if (!memoryEdit) return;
    const value = memoryEdit.value.trim();
    const err = await updateLoad(memoryEdit.load.id, { plan_prev_note: value || null });
    if (err) setMessage({ text: `Nie udało się zapisać: ${err}`, kind: "error" });
    setMemoryEdit(null);
  }, [memoryEdit, updateLoad]);

  if (isLoading) return <div className="p-6 text-zinc-500">Wczytywanie planu…</div>;
  if (isError) {
    return (
      <div className="p-6 text-red-600">
        Błąd wczytywania planu: {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }

  const pierwszy = board.days[0];
  const ostatni = board.days[board.days.length - 1];

  // Kolumny są cztery i stałe (eksport tył/przód, import tył/przód) — dni idą JEDEN POD DRUGIM,
  // więc przewija się w dół, nie w bok (właściciel: "przewijanie ma być góra-dół").
  const slotEdge = (slotIndex: number, direction: "I" | "E"): string =>
    direction === "E" && slotIndex === PLAN_SLOTS.length - 1 ? "border-r-2" : "border-r";

  const renderSide = (row: PlanRow, block: PlanRowBlock, direction: "I" | "E", nieobecny: boolean) => {
    const cells: PlanCell[] = direction === "E" ? block.eksport : block.import;
    const columnDay = direction === "E" ? block.day.dayExport : block.day.dayImport;

    return cells.map((cell, index) => {
      if (cell.covered) return null;
      const slot = PLAN_SLOTS[index];
      const target: DropTarget = { row, slot, direction, day: columnDay };
      const refusal = selected ? assignRefusal(selected, target) : null;
      const canDrop = Boolean(selected) && !refusal;
      // Scalony kafelek 40/45 zjada sąsiednie miejsce, więc kreska ma stanąć po drugiej kolumnie.
      const edge = slotEdge(index + cell.span - 1, direction);

      return (
        <td
          key={`${block.day.dayExport}-${direction}-${slot}`}
          colSpan={cell.span}
          data-testid={`slot-${direction}-${slot}`}
          data-pojazd={row.plate}
          data-dzien={block.day.dayExport}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => handleDrop(event, target)}
          onClick={() => {
            if (!selected || cell.load) return;
            void place(selected, target);
          }}
          className={`border-b border-zinc-200 p-1 align-top dark:border-zinc-800 ${edge} ${
            cell.load ? "" : canDrop ? "cursor-pointer bg-blue-50/60 dark:bg-blue-950/40" : nieobecny ? "bg-amber-50/60 dark:bg-amber-950/30" : ""
          }`}
        >
          {cell.load ? (
            <PlanTile
              load={cell.load}
              memory={cell.memory}
              memoryIsManual={cell.memoryIsManual}
              selected={selectedId === cell.load.id}
              onSelect={() => setSelectedId((current) => (current === cell.load!.id ? null : cell.load!.id))}
              onDragStart={(event) => event.dataTransfer.setData("text/plain", cell.load!.id)}
              onRemove={() => void remove(cell.load!)}
              onEditMemory={
                direction === "E" ? () => setMemoryEdit({ load: cell.load!, value: cell.memory }) : undefined
              }
            />
          ) : (
            <div className="min-h-[46px] rounded border border-dashed border-zinc-200 text-center text-[11px] leading-[46px] text-zinc-300 dark:border-zinc-800 dark:text-zinc-700">
              {selected ? (refusal ? "nie tutaj" : "wstaw tutaj") : nieobecny ? "wolne" : ""}
            </div>
          )}
          {cell.conflicts.length > 0 && (
            <div className="mt-1 rounded border border-red-300 bg-red-50 px-1 py-0.5 text-[10px] text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              Nie mieści się na zestawie:{" "}
              {cell.conflicts.map((l) => l.container_number || l.order_number || "(bez numeru)").join(", ")}
            </div>
          )}
        </td>
      );
    });
  };

  const dayHeaderClass = (planDay: PlanDay): string =>
    planDay.offset === 0
      ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">
        <button
          type="button"
          onClick={() => setDay(previousWorkingDay(day))}
          className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          ‹ poprzedni
        </button>
        <input
          type="date"
          value={day}
          onChange={(event) => event.target.value && setDay(event.target.value)}
          aria-label="Dzień planu"
          className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          onClick={() => setDay(nextWorkingDay(day))}
          className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          następny ›
        </button>
        <button
          type="button"
          onClick={() => setDay(defaultDay())}
          className="rounded border border-zinc-300 px-2 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          dziś
        </button>
        <span className="ml-2 text-zinc-500" data-testid="okno-planu">
          okno {PLAN_DAYS_BEFORE > 0 ? `−${PLAN_DAYS_BEFORE}` : "0"} / +{PLAN_DAYS_AFTER}:{" "}
          <strong className="text-zinc-800 dark:text-zinc-200">{formatShortDay(pierwszy.dayExport)}</strong> –{" "}
          <strong className="text-zinc-800 dark:text-zinc-200">{formatShortDay(ostatni.dayImport)}</strong>
        </span>
        <label className="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={tylkoZajete}
            onChange={(event) => setTylkoZajete(event.target.checked)}
            aria-label="Tylko auta z ładunkiem"
          />
          tylko auta z ładunkiem
        </label>
        {selected && (
          <span className="rounded bg-blue-100 px-2 py-1 text-blue-900 dark:bg-blue-900 dark:text-blue-100">
            Wybrano: {selected.container_number || selected.order_number || "zlecenie"} — kliknij wolne miejsce.{" "}
            <button type="button" className="underline" onClick={() => setSelectedId(null)}>
              anuluj
            </button>
          </span>
        )}
        {message && (
          <span
            className={`rounded px-2 py-1 ${
              message.kind === "error"
                ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
                : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            }`}
          >
            {message.text}{" "}
            <button type="button" className="underline" onClick={() => setMessage(null)}>
              ok
            </button>
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-20">
              <tr>
                <th
                  rowSpan={2}
                  className="sticky left-0 z-30 w-56 border-b border-r border-zinc-300 bg-zinc-100 px-2 py-1 text-left dark:border-zinc-700 dark:bg-zinc-900"
                >
                  Pojazd / kierowca
                </th>
                <th
                  colSpan={2}
                  className="border-b border-r-2 border-zinc-300 bg-emerald-50 px-2 py-1 text-center font-semibold text-emerald-900 dark:border-zinc-700 dark:bg-emerald-950 dark:text-emerald-100"
                >
                  EKSPORT — dzień z nagłówka sekcji
                </th>
                <th
                  colSpan={2}
                  className="border-b border-zinc-300 bg-sky-50 px-2 py-1 text-center font-semibold text-sky-900 dark:border-zinc-700 dark:bg-sky-950 dark:text-sky-100"
                >
                  IMPORT — następny dzień roboczy po nim
                </th>
              </tr>
              <tr>
                {(["E", "I"] as const).flatMap((direction) =>
                  PLAN_SLOTS.map((slot, slotIndex) => (
                    <th
                      key={`${direction}-${slot}`}
                      className={`w-64 border-b border-zinc-300 bg-zinc-50 px-2 py-0.5 text-left font-normal text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 ${slotEdge(
                        slotIndex,
                        direction
                      )}`}
                    >
                      {PLAN_SLOT_LABELS[slot]}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {board.days.map((planDay, dayIndex) => (
                <Fragment key={planDay.dayExport}>
                  {/* Dni idą jeden pod drugim — nagłówek sekcji zamiast kolejnych kolumn w bok.
                      Sam napis jest przyklejony do lewej, żeby nie uciekał przy przewijaniu w bok
                      (ta sama sztuczka co przy nagłówkach dnia w Zestawieniu). */}
                  <tr>
                    <td
                      colSpan={5}
                      data-testid="naglowek-dnia"
                      data-dzien={planDay.dayExport}
                      className={`border-y border-zinc-300 px-2 py-1 text-sm font-semibold dark:border-zinc-700 ${dayHeaderClass(
                        planDay
                      )} ${dayIndex > 0 ? "border-t-4 border-t-zinc-400 dark:border-t-zinc-600" : ""}`}
                    >
                      <div className="sticky left-2 w-fit">
                        {formatDay(planDay.dayExport)}
                        {planDay.offset !== 0 && (
                          <span className="ml-1 font-normal opacity-70">
                            ({planDay.offset > 0 ? `+${planDay.offset}` : planDay.offset})
                          </span>
                        )}
                        <span className="ml-2 font-normal opacity-70">
                          · import: {formatDay(planDay.dayImport)}
                        </span>
                      </div>
                    </td>
                  </tr>
                  {board.rows.map((row) => {
                    const block = row.blocks[dayIndex];
                    const nieobecny = block.absences.length > 0;
                    const pusty = !block.eksport.some((c) => c.load) && !block.import.some((c) => c.load);
                    if (tylkoZajete && pusty) return null;
                    return (
                      <tr key={`${planDay.dayExport}-${row.plate}`} className="bg-white dark:bg-zinc-950">
                        <th
                          scope="row"
                          data-testid="wiersz-pojazdu"
                          data-pojazd={row.plate}
                          data-dzien={planDay.dayExport}
                          className={`sticky left-0 z-10 border-b border-r border-zinc-200 px-2 py-1 text-left align-top font-normal dark:border-zinc-800 ${
                            nieobecny ? "bg-amber-50 dark:bg-amber-950" : "bg-white dark:bg-zinc-950"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <div>
                              <div className="font-semibold text-zinc-900 dark:text-zinc-100">{row.plate}</div>
                              <div className="text-zinc-600 dark:text-zinc-400">
                                {row.driverName || "— brak kierowcy —"}
                              </div>
                              {row.trailerPlate && <div className="text-zinc-400">nacz. {row.trailerPlate}</div>}
                              <div className="text-zinc-500">
                                ładowność:{" "}
                                {row.payloadKg === null ? (
                                  <span className="text-zinc-400">—</span>
                                ) : (
                                  <strong>{row.payloadKg.toLocaleString("pl-PL")} kg</strong>
                                )}
                              </div>
                              {!row.inFleet && (
                                <div className="text-amber-700 dark:text-amber-400">spoza Panelu floty</div>
                              )}
                              {/* Nieobecności TEGO dnia — auto bywa wolne tylko w części okna. */}
                              {block.absences.map((absence) => (
                                <div key={absence.label} className="text-amber-700 dark:text-amber-400">
                                  {absence.label}
                                </div>
                              ))}
                            </div>
                            <button
                              type="button"
                              onClick={() => setSettingsRow(row)}
                              title="Kierowca, ładowność, nieobecność"
                              className="rounded border border-zinc-300 px-1 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                            >
                              ⚙
                            </button>
                          </div>
                        </th>
                        {renderSide(row, block, "E", nieobecny)}
                        {renderSide(row, block, "I", nieobecny)}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
              {board.rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                    Brak pojazdów. Plan bierze auta z Panelu floty (ciągniki i solówki).
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="border-b border-zinc-200 px-3 py-2 text-sm font-semibold dark:border-zinc-800">
            Do zaplanowania ({board.unassigned.length})
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
            {board.unassigned.length === 0 && (
              <p className="px-1 py-3 text-xs text-zinc-500">
                Wszystkie zlecenia z pokazanych dni mają przypisany pojazd.
              </p>
            )}
            {board.unassigned.map((load) => (
              <button
                key={load.id}
                type="button"
                draggable
                data-testid="do-zaplanowania"
                data-zlecenie={load.order_number ?? ""}
                onDragStart={(event) => event.dataTransfer.setData("text/plain", load.id)}
                onClick={() => setSelectedId((current) => (current === load.id ? null : load.id))}
                className={`w-full cursor-grab rounded border px-2 py-1 text-left text-[11px] leading-tight active:cursor-grabbing ${
                  selectedId === load.id
                    ? "border-blue-500 bg-blue-50 ring-2 ring-blue-400 dark:bg-blue-950"
                    : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700"
                }`}
              >
                <div className="flex items-center gap-1">
                  <span
                    className={`rounded px-1 text-[10px] font-semibold ${
                      load.direction === "E"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100"
                        : "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100"
                    }`}
                  >
                    {load.direction === "E" ? "EKS" : "IMP"}
                  </span>
                  <span className="font-semibold">{load.container_number || load.order_number || "(bez numeru)"}</span>
                  {load.load_date ? (
                    <span className="text-zinc-400">{formatShortDay(load.load_date)}</span>
                  ) : (
                    <span
                      className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-900 dark:text-amber-100"
                      title="Zlecenie nie ma daty — położenie go na miejscu ustawi datę tej kolumny"
                    >
                      bez daty
                    </span>
                  )}
                </div>
                <div className="text-zinc-600 dark:text-zinc-400">
                  {[load.city, load.container_size, load.shipping_line].filter(Boolean).join(" · ")}
                </div>
              </button>
            ))}
          </div>
          <p className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-800">
            Przeciągnij na miejsce w tabeli albo kliknij zlecenie i kliknij wolne miejsce.
          </p>
        </aside>
      </div>

      {settingsRow && (
        <PlanRowSettingsDialog
          row={settingsRow}
          drivers={(fleet ?? EMPTY_FLEET).drivers}
          absences={absences ?? []}
          onClose={() => setSettingsRow(null)}
        />
      )}

      {memoryEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded border border-zinc-300 bg-white p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <h2 className="mb-1 font-semibold">Po jakim imporcie jest ten kontener</h2>
            <p className="mb-3 text-xs text-zinc-500">
              Puste pole = appka wylicza to sama z planu (ostatni import tego pojazdu). Wpisany tekst zostaje na stałe
              przy tym zleceniu.
            </p>
            <input
              autoFocus
              value={memoryEdit.value}
              onChange={(event) => setMemoryEdit({ ...memoryEdit, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveMemory();
                if (event.key === "Escape") setMemoryEdit(null);
              }}
              className="w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setMemoryEdit(null)} className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700">
                Anuluj
              </button>
              <button type="button" onClick={() => void saveMemory()} className="rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900">
                Zapisz
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
