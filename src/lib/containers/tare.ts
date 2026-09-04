// Tara kontenera wg typu — reguła właściciela: "w zależności od typu kontenera będziemy liczyć
// wagę brutto: 20DV 2200 kg, 40DV 3700 kg, 40HC 3900 kg, 45 4800 kg". Waga brutto zlecenia =
// waga towaru (net_weight_kg) + tara. Typ z dokumentów bywa zapisany różnie ("20DV", "40 HC",
// "40HQ", "45HC") — normalizujemy do rodziny: 45 → 4800, 40 wysoki (HC/HQ) → 3900, 40 → 3700,
// 20 → 2200. Nieznany typ = null (brutto nie liczymy, zamiast zgadywać).
const TARE_KG = { "20": 2200, "40": 3700, "40HC": 3900, "45": 4800 } as const;

export type ContainerFamily = keyof typeof TARE_KG;

/**
 * Rodzina kontenera z zapisu ze zlecenia ("20DV", "40 HC", "40HQ", "45HC"). Nieznany zapis = null
 * (nie zgadujemy). Poza tarą korzysta z tego Plan wspaniały: 40/45 zajmuje CAŁY zestaw, więc od tej
 * odpowiedzi zależy, czy kafelek scala obie kolumny wiersza i czy kontener wolno dać na solówkę.
 */
export function containerSizeFamily(containerSize: string | null | undefined): ContainerFamily | null {
  const size = (containerSize ?? "").toUpperCase().replace(/[\s'"\u2019-]/g, "");
  if (!size) return null;
  if (size.startsWith("45")) return "45";
  if (size.startsWith("40")) return /H[CQ]/.test(size) ? "40HC" : "40";
  if (size.startsWith("20")) return "20";
  return null;
}

export function containerTareKg(containerSize: string | null | undefined): number | null {
  const family = containerSizeFamily(containerSize);
  return family === null ? null : TARE_KG[family];
}

export function computeGrossWeightKg(netWeightKg: number | null | undefined, containerSize: string | null | undefined): number | null {
  const tare = containerTareKg(containerSize);
  if (tare === null || netWeightKg === null || netWeightKg === undefined || !Number.isFinite(netWeightKg)) return null;
  return netWeightKg + tare;
}

/**
 * Wolno nadpisać tylko puste albo czysto liczbowe brutto — tekst typu "według armatora" zostaje.
 *
 * Drugi argument wyłącza przeliczanie CAŁKOWICIE: waga brutto pobrana z Baltic Hub jest wg
 * właściciela nadrzędna ("ta jest nadrzędna i nadpisuje dowolne wartości ze zleceń"), więc
 * suma "towar + tara" nie może jej po cichu zastąpić przy najbliższej edycji wagi netto albo typu
 * kontenera. Tara jest tylko oszacowaniem tablicowym; terminal podaje wagę zważoną.
 */
export function canOverwriteGrossWeight(
  current: string | null | undefined,
  terminalGrossWeightKg?: number | null
): boolean {
  if (terminalGrossWeightKg !== null && terminalGrossWeightKg !== undefined) return false;
  const value = (current ?? "").trim();
  return value === "" || /^\d+([.,]\d+)?(\s*kg)?$/i.test(value);
}

/** Liczba kg z tekstu dokumentu ("18 450 kg", "18450,5") — null, gdy nie ma cyfr. */
export function parseWeightKg(raw: string): number | null {
  const match = raw.replace(/\s/g, "").match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const value = Number(match[0].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}
