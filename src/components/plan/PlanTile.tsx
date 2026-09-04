"use client";

import type { Load } from "@/types/load";
import { containerSizeFamily } from "@/lib/containers/tare";
import { EMPTY_DROP_LOCATIONS } from "@/lib/orderTemplates/pickupLocations";
import { withCurrentOption } from "@/lib/fleet/fleetStore";

/**
 * Kafelek jednego kontenera na zestawie.
 *
 * Górna, pogrubiona linia to "gdzie lądujemy" (miejscowość + firma) — tak czyta to arkusz klienta.
 * Dolna, szara linia w EKSPORCIE to pamiątka "po jakim imporcie jest ten kontener"; w imporcie jej
 * nie ma (właściciel: "import jest prosty, tam są tylko realne ładunki z informacjami o nich").
 */
/**
 * Kontener, który został na zestawie po imporcie z tego samego dnia — podpowiedź, NIE zlecenie.
 *
 * Właściciel: "kontenery będące dnia X w imporcie będą szły automatycznie do eksportu tego samego
 * dnia, ale zostawiamy tylko informacje o miejscowości, gestii i nr kontenera; ładunki na export
 * (export / krajówka / zjazd na pusto) będziemy właśnie w eksporcie dodawać". Stąd trzy pola i
 * przerywana ramka: nic tu jeszcze nie jest zaplanowane, miejsce dalej przyjmuje zlecenie.
 */
export function PlanCarryTile({
  load,
  onDropOffChange,
}: {
  load: Load;
  /** Zapis "gdzie składamy na pusto" — `submitted_where` na TYM imporcie. */
  onDropOffChange: (value: string) => void;
}) {
  const opis = [load.city, load.shipping_line, load.container_number]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  const dropOff = (load.submitted_where ?? "").trim();

  return (
    <div
      data-testid="kafelek-z-importu"
      data-kontener={load.container_number ?? ""}
      title="Kontener został po imporcie z tego samego dnia — dołóż tu ładunek (export / krajówka / zjazd na pusto)"
      className="h-full rounded border border-dashed border-zinc-300 bg-zinc-50/70 px-1.5 py-1 text-[11px] leading-tight text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400"
    >
      <div className="text-[10px] uppercase tracking-wide text-zinc-400">z importu</div>
      {opis.length > 0 ? (
        <div className="truncate text-zinc-700 dark:text-zinc-300">{opis.join(" · ")}</div>
      ) : (
        <div className="text-zinc-400">(bez danych)</div>
      )}

      {/* Dopóki na kontener nie ma ładunku, jedzie na pusto — i trzeba wiedzieć DOKĄD.
          Zapisuje się na tym imporcie ("Złożenie gdzie"), więc widać to też w Zestawieniu.
          `stopPropagation`, bo komórka pod spodem jest celem kliknięcia przy wstawianiu zlecenia. */}
      <label className="mt-0.5 flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
        <span className="shrink-0 text-zinc-400">na pusto do:</span>
        <select
          data-testid="gdzie-skladamy"
          value={dropOff}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            event.stopPropagation();
            onDropOffChange(event.target.value);
          }}
          className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-1 py-0 text-[11px] dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">— wybierz —</option>
          {withCurrentOption([...EMPTY_DROP_LOCATIONS], dropOff).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Waga brutto bywa tekstem ("według armatora"), więc formatujemy tylko czystą liczbę. */
function formatGrossWeight(raw: string | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const match = value.match(/^\d+(?:[.,]\d+)?$/);
  if (!match) return value;
  return `${Number(value.replace(",", ".")).toLocaleString("pl-PL")} kg`;
}

export function PlanTile({
  load,
  direction,
  memory,
  memoryIsManual,
  selected,
  onSelect,
  onDragStart,
  onRemove,
  onEditMemory,
}: {
  load: Load;
  direction: "I" | "E";
  memory: string;
  memoryIsManual: boolean;
  selected: boolean;
  onSelect: () => void;
  onDragStart: (event: React.DragEvent) => void;
  onRemove: () => void;
  onEditMemory?: () => void;
}) {
  const family = containerSizeFamily(load.container_size);
  // Właściciel: "dodaj wagę brutto przy imporcie, odprawa, adr/sent, spedycja zlecająca".
  // Import ma nieść komplet informacji o ładunku — eksport zostaje zwięzły.
  const isImport = direction === "I";
  const adr = (load.adr_flag ?? "").trim();
  const brutto = isImport ? formatGrossWeight(load.gross_weight) : "";
  const odprawa = isImport ? (load.customs_status ?? "").trim() : "";
  const spedycja = isImport ? (load.forwarder ?? "").trim() : "";
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
        {isImport && adr && (
          <span
            data-testid="adr-sent"
            title="ADR / SENT — ładunek pod nadzorem"
            className="ml-auto shrink-0 rounded bg-red-200 px-1 text-[10px] font-semibold text-red-900 dark:bg-red-900 dark:text-red-100"
          >
            {adr}
          </span>
        )}
      </div>

      {drugaLinia && <div className="truncate text-zinc-700 dark:text-zinc-300">{drugaLinia}</div>}
      {trzeciaLinia && <div className="truncate text-zinc-500 dark:text-zinc-500">{trzeciaLinia}</div>}

      {(brutto || odprawa) && (
        <div data-testid="brutto-odprawa" className="truncate text-zinc-600 dark:text-zinc-400">
          {[brutto && `brutto ${brutto}`, odprawa && `odprawa: ${odprawa}`].filter(Boolean).join(" · ")}
        </div>
      )}
      {spedycja && (
        <div data-testid="spedycja" className="truncate text-zinc-500 dark:text-zinc-500">
          spedycja: {spedycja}
        </div>
      )}

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
