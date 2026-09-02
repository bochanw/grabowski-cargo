// Tara kontenera wg typu — reguła właściciela: "w zależności od typu kontenera będziemy liczyć
// wagę brutto: 20DV 2200 kg, 40DV 3700 kg, 40HC 3900 kg, 45 4800 kg". Waga brutto zlecenia =
// waga towaru (net_weight_kg) + tara. Typ z dokumentów bywa zapisany różnie ("20DV", "40 HC",
// "40HQ", "45HC") — normalizujemy do rodziny: 45 → 4800, 40 wysoki (HC/HQ) → 3900, 40 → 3700,
// 20 → 2200. Nieznany typ = null (brutto nie liczymy, zamiast zgadywać).
const TARE_KG = { "20": 2200, "40": 3700, "40HC": 3900, "45": 4800 } as const;

export function containerTareKg(containerSize: string | null | undefined): number | null {
  const size = (containerSize ?? "").toUpperCase().replace(/[\s'"’-]/g, "");
  if (!size) return null;
  if (size.startsWith("45")) return TARE_KG["45"];
  if (size.startsWith("40")) return /H[CQ]/.test(size) ? TARE_KG["40HC"] : TARE_KG["40"];
  if (size.startsWith("20")) return TARE_KG["20"];
  return null;
}

export function computeGrossWeightKg(netWeightKg: number | null | undefined, containerSize: string | null | undefined): number | null {
  const tare = containerTareKg(containerSize);
  if (tare === null || netWeightKg === null || netWeightKg === undefined || !Number.isFinite(netWeightKg)) return null;
  return netWeightKg + tare;
}

/** Wolno nadpisać tylko puste albo czysto liczbowe brutto — tekst typu "według armatora" zostaje. */
export function canOverwriteGrossWeight(current: string | null | undefined): boolean {
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
