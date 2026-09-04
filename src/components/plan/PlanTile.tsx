"use client";

import type { Load } from "@/types/load";
import { containerSizeFamily } from "@/lib/containers/tare";

/**
 * Kafelek jednego kontenera na zestawie.
 *
 * Górna, pogrubiona linia to "gdzie lądujemy" (miejscowość + firma) — tak czyta to arkusz klienta.
 * Dolna, szara linia w EKSPORCIE to pamiątka "po jakim imporcie jest ten kontener"; w imporcie jej
 * nie ma (właściciel: "import jest prosty, tam są tylko realne ładunki z informacjami o nich").
 */
export function PlanTile({
  load,
  memory,
  memoryIsManual,
  selected,
  onSelect,
  onDragStart,
  onRemove,
  onEditMemory,
}: {
  load: Load;
  memory: string;
  memoryIsManual: boolean;
  selected: boolean;
  onSelect: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onRemove: () => void;
  onEditMemory?: () => void;
}) {
  const family = containerSizeFamily(load.container_size);
  const gdzie = [load.city, load.company_name].map((v) => (v ?? "").trim()).filter(Boolean).join(", ");
  const drugaLinia = [load.container_number, load.container_size, load.shipping_line]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  const trzeciaLinia = [load.pickup_type, load.time_of_day, load.order_number]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      data-testid="kafelek"
      data-zlecenie={load.order_number ?? ""}
      data-kontener={load.container_number ?? ""}
      className={`group relative h-full cursor-grab rounded border px-1.5 py-1 text-[11px] leading-tight active:cursor-grabbing ${
        selected
          ? "border-blue-500 bg-blue-50 ring-2 ring-blue-400 dark:bg-blue-950"
          : "border-zinc-300 bg-white hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
      }`}
    >
      <button
        type="button"
        title="Zdejmij z planu"
        aria-label="Zdejmij z planu"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        className="absolute right-0.5 top-0.5 hidden rounded px-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 group-hover:block dark:hover:bg-zinc-800"
      >
        ×
      </button>

      <div className="flex items-start gap-1 pr-3">
        {family && (
          <span
            className={`shrink-0 rounded px-1 text-[10px] font-semibold ${
              family === "20"
                ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
                : "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100"
            }`}
            title={family === "20" ? "20 stóp — mieści się z drugim kontenerem" : "Zajmuje cały zestaw"}
          >
            {load.container_size}
          </span>
        )}
        <span className="font-semibold text-zinc-900 dark:text-zinc-100">{gdzie || "(bez miejscowości)"}</span>
      </div>

      {drugaLinia && <div className="truncate text-zinc-700 dark:text-zinc-300">{drugaLinia}</div>}
      {trzeciaLinia && <div className="truncate text-zinc-500 dark:text-zinc-500">{trzeciaLinia}</div>}

      {onEditMemory && (
        <div
          className="mt-0.5 truncate border-t border-dashed border-zinc-200 pt-0.5 text-zinc-500 dark:border-zinc-700 dark:text-zinc-500"
          title={memoryIsManual ? "Wpisane ręcznie — kliknij, żeby zmienić" : "Wyliczone z planu — kliknij, żeby nadpisać"}
          onClick={(event) => {
            event.stopPropagation();
            onEditMemory();
          }}
        >
          <span className="text-zinc-400">po: </span>
          {memory ? (
            <span className={memoryIsManual ? "italic" : ""}>{memory}</span>
          ) : (
            <span className="text-zinc-400">— (dopisz)</span>
          )}
        </div>
      )}
    </div>
  );
}
