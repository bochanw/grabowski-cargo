"use client";

import { useMemo, useState } from "react";
import type { Load, Direction } from "@/types/load";
import { COLUMNS, BLOCK_LABELS, type ColumnBlock } from "./columns";

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("pl-PL", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function formatDayHeading(loadDate: string | null): string {
  if (!loadDate) return "Bez daty";
  const parsed = new Date(`${loadDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return loadDate;
  return WEEKDAY_FORMATTER.format(parsed);
}

function formatCell(value: unknown, kind: "number" | "date" | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (kind === "number" && typeof value === "number") {
    return value.toLocaleString("pl-PL");
  }
  return String(value);
}

interface DayGroup {
  dateKey: string;
  loads: Load[];
}

function groupByDay(loads: Load[]): DayGroup[] {
  const map = new Map<string, Load[]>();
  for (const load of loads) {
    const key = load.load_date ?? "";
    const bucket = map.get(key);
    if (bucket) bucket.push(load);
    else map.set(key, [load]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    })
    .map(([dateKey, dayLoads]) => ({ dateKey, loads: dayLoads }));
}

const DIRECTION_ORDER: Direction[] = ["E", "I"];
const DIRECTION_LABELS: Record<Direction, string> = {
  E: "Eksport",
  I: "Import",
};

export function ZestawienieTable({ loads }: { loads: Load[] }) {
  const [visibleBlocks, setVisibleBlocks] = useState<Record<ColumnBlock, boolean>>({
    ladunek: true,
    rozliczenie: false,
    fakturowanie: false,
    inne: false,
  });

  const columns = useMemo(
    () => COLUMNS.filter((column) => visibleBlocks[column.block]),
    [visibleBlocks]
  );

  const dayGroups = useMemo(() => groupByDay(loads), [loads]);

  function toggleBlock(block: ColumnBlock) {
    if (block === "ladunek") return;
    setVisibleBlocks((prev) => ({ ...prev, [block]: !prev[block] }));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Zestawienie
        </span>
        <div className="ml-auto flex gap-2">
          {(Object.keys(BLOCK_LABELS) as ColumnBlock[])
            .filter((block) => block !== "ladunek")
            .map((block) => (
              <button
                key={block}
                type="button"
                onClick={() => toggleBlock(block)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  visibleBlocks[block]
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                {BLOCK_LABELS[block]}
              </button>
            ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full min-w-max border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-zinc-100 dark:bg-zinc-900">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`whitespace-nowrap border-b border-zinc-200 px-2 py-1.5 text-left font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400 ${
                    column.align === "right" ? "text-right" : ""
                  }`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dayGroups.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-2 py-6 text-center text-zinc-500">
                  Brak ładunków.
                </td>
              </tr>
            )}
            {dayGroups.map((group) => (
              <DayGroupRows key={group.dateKey} group={group} columns={columns} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DayGroupRows({
  group,
  columns,
}: {
  group: DayGroup;
  columns: typeof COLUMNS;
}) {
  const byDirection = new Map<Direction, Load[]>();
  for (const direction of DIRECTION_ORDER) byDirection.set(direction, []);
  for (const load of group.loads) {
    byDirection.get(load.direction)?.push(load);
  }

  const presentDirections = DIRECTION_ORDER.filter(
    (direction) => (byDirection.get(direction)?.length ?? 0) > 0
  );

  return (
    <>
      <tr>
        <td
          colSpan={columns.length}
          className="border-y border-zinc-300 bg-zinc-200 px-2 py-1 text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          {formatDayHeading(group.dateKey || null)}
        </td>
      </tr>
      {presentDirections.map((direction, index) => (
        <DirectionRows
          key={direction}
          direction={direction}
          loads={byDirection.get(direction) ?? []}
          columns={columns}
          isFirst={index === 0}
        />
      ))}
    </>
  );
}

function DirectionRows({
  direction,
  loads,
  columns,
  isFirst,
}: {
  direction: Direction;
  loads: Load[];
  columns: typeof COLUMNS;
  isFirst: boolean;
}) {
  return (
    <>
      <tr>
        {/* Gruba kreska oddziela eksporty od importów w obrębie dnia — nie
            tylko kolor tła, ale wyraźna, pogrubiona krawędź. */}
        <td
          colSpan={columns.length}
          className={`bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-950 dark:text-zinc-500 ${
            !isFirst ? "border-t-4 border-zinc-900 dark:border-zinc-100" : ""
          }`}
        >
          {DIRECTION_LABELS[direction]}
        </td>
      </tr>
      {loads.map((load) => (
        <tr
          key={load.id}
          className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900"
        >
          {columns.map((column) => (
            <td
              key={column.key}
              className={`whitespace-nowrap px-2 py-1 text-zinc-800 dark:text-zinc-200 ${
                column.align === "right" ? "text-right tabular-nums" : ""
              }`}
            >
              {formatCell(load[column.key], column.kind)}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
