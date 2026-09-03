import type { Load } from "../../types/load";

// Tytuł pozycji na fakturze — reguła właściciela: "Transport kontenera <nr kontenera>, na trasie
// <trasa>, nr zlecenia <nr>", gdzie trasa dla importu to "<port> - <miejscowość> - <port>", a dla
// eksportu "Poimport - <miejscowość> - <port>" albo "z Depotu - <miejscowość> - <port>", gdy pusty
// kontener jest pobierany z depotu. Tytuł jest tylko PROPOZYCJĄ — okno faktury pokazuje go do edycji.

export type ExportOrigin = "poimport" | "depot";

const EXPORT_ORIGIN_LABEL: Record<ExportOrigin, string> = { poimport: "Poimport", depot: "z Depotu" };

// Miasto portu po terminalu podjęcia: GCT (Gdynia Container Terminal) i BCT (Bałtycki Terminal
// Kontenerowy) leżą w Gdyni, Baltic Hub w Gdańsku. Właściciel podał w regule "Gdańsk" — dla
// terminali gdyńskich wpisanie Gdańska byłoby nieprawdą na fakturze, stąd mapowanie; bez terminalu
// zostaje Gdańsk. Do zmiany w tym jednym miejscu, jeśli właściciel woli inaczej.
export function portCityForPickup(pickupType: string | null | undefined): string {
  const pickup = (pickupType ?? "").toUpperCase();
  if (pickup.startsWith("GCT") || pickup.startsWith("BCT")) return "Gdynia";
  return "Gdańsk";
}

export function buildRoute(load: Pick<Load, "direction" | "city" | "pickup_type">, exportOrigin: ExportOrigin): string {
  const port = portCityForPickup(load.pickup_type);
  const city = (load.city ?? "").trim() || "?";
  return load.direction === "E" ? `${EXPORT_ORIGIN_LABEL[exportOrigin]} - ${city} - ${port}` : `${port} - ${city} - ${port}`;
}

/**
 * Tytuł OSOBNEJ pozycji z dodatkiem paliwowym — tylko dla kontrahentów z `baf_invoice_mode =
 * 'separate'` (patrz src/types/contractor.ts). Nazywa to samo zlecenie co pozycja frachtowa, żeby
 * na fakturze zbiorczej dało się zestawić dodatek z konkretnym kontenerem.
 */
export function buildBafPositionTitle(
  load: Pick<Load, "container_number" | "order_number" | "baf_percentage">
): string {
  const container = (load.container_number ?? "").trim() || "?";
  const order = (load.order_number ?? "").trim() || "?";
  const percent = load.baf_percentage !== null && load.baf_percentage !== undefined ? ` ${load.baf_percentage}%` : "";
  return `Dodatek paliwowy BAF${percent} — kontener ${container}, nr zlecenia ${order}`;
}

export function buildInvoiceTitle(
  load: Pick<Load, "direction" | "city" | "pickup_type" | "container_number" | "order_number">,
  exportOrigin: ExportOrigin = "poimport"
): string {
  const container = (load.container_number ?? "").trim() || "?";
  const order = (load.order_number ?? "").trim() || "?";
  return `Transport kontenera ${container}, na trasie ${buildRoute(load, exportOrigin)}, nr zlecenia ${order}`;
}
