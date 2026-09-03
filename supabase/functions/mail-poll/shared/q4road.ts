// PLIK GENEROWANY — nie edytuj tutaj. Źródło: src/lib/orderTemplates/q4road.ts
// Wygenerowane przez scripts/build-edge-shared.mjs (patrz komentarz w skrypcie).

import { EMPTY_PARSED_ORDER, type ParsedOrder } from "./parsedOrder.ts";
import { matchPickupLocation } from "./pickupLocations.ts";
import { computeGrossWeightKg, parseWeightKg } from "./tare.ts";

// Szablony Q4Road — pierwszy znany klient appki. Jedno zlecenie = DWA dokumenty PDF:
//  1. "ZLECENIE SPEDYCYJNE" — spedytor, stawka, warunek płatności, miejsce rozładunku, odprawa.
//  2. "KONTENEROWY LIST PRZEWOZOWY" (dokument dla kierowcy) — kierowca, dowód, ciągnik/naczepa,
//     telefon, miejsce podjęcia (GCT/BCT/BHub), PIN/booking, nazwa towaru, waga, złożenie pustego.
// Wspólne dla obu: numer zlecenia + kierunek w nagłówku, kontener, miejsce rozładunku, odprawa.
//
// Regexy dopasowane do FAKTYCZNEGO tekstu wyciąganego przez pdf.js z tych layoutów (zweryfikowane
// na parze dokumentów do ZD/1797/6/2026). Każde dopasowanie jest niewymagające (grupa między dwiema
// znanymi etykietami), żeby drobne różnice w kolejnym zleceniu tego klienta (inny adres, więcej
// miejsc rozładunku, puste pole) nie wywaliły całego parsera. Dokument to zwykle kilka stron
// sklejonych w jeden ciąg — NIGDY nie kotwiczyć do końca tekstu (`$`), tylko do następnej etykiety
// (patrz pułapka opisana w CLAUDE.md). Test: `npx tsx scratch-templates.test.mts` na prawdziwych
// PDF-ach (tsx rozwiązuje aliasy `@/` i importy bez rozszerzeń tak jak Next).

export function detectQ4RoadOrder(text: string): boolean {
  return /q4road/i.test(text) && /ZLECENIE\s+SPEDYCYJNE/i.test(text);
}

export function detectQ4RoadWaybill(text: string): boolean {
  return /q4road/i.test(text) && /KONTENEROWY\s+LIST\s+PRZEWOZOWY/i.test(text);
}

function between(text: string, startLabel: RegExp, endLabel: RegExp): string {
  const start = text.match(startLabel);
  if (!start || start.index === undefined) return "";
  const rest = text.slice(start.index + start[0].length);
  const end = rest.match(endLabel);
  return (end && end.index !== undefined ? rest.slice(0, end.index) : rest).trim();
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "");
  // Polski zapis "3 296,00" — przecinek jako separator dziesiętny, kropka/spacja jako tysięczny.
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

// "Import | ZD/1797/6/2026" — ten sam nagłówek w obu dokumentach.
function parseHeader(text: string, result: ParsedOrder) {
  const headerMatch = text.match(/\b(Import|Eksport|Export)\s*\|\s*([A-Za-z0-9/._-]+)/i);
  if (headerMatch) {
    result.direction = headerMatch[1].toLowerCase() === "import" ? "I" : "E";
    result.order_number = headerMatch[2];
  }
}

// Pierwszy wiersz tabeli "Miejsca rozładunku": firma + adres, potem data i godzina — ta sama
// tabela w obu dokumentach. Świadomie tylko wiersz "1" — appka obsługuje jedno miejsce
// rozładunku na rekord; kolejne dyspozytor dopisze ręcznie.
function parseUnloadingRow(text: string, result: ParsedOrder) {
  const rowMatch = text.match(/Uwagi\s+1\s+(.+?)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})/i);
  if (!rowMatch) return;
  const [, place, dateStr, time] = rowMatch;
  const parts = place.split(/\s+(?=ul\.)/i);
  result.company_name = parts[0]?.trim() ?? "";
  if (parts[1]) {
    result.address = parts[1].trim();
    const cityMatch = parts[1].match(/,\s*\d{2}-\d{3}\s+(.+)$/);
    if (cityMatch) result.city = cityMatch[1].trim();
  }
  const [dd, mm, yyyy] = dateStr.split(".");
  result.delivery_date = `${yyyy}-${mm}-${dd}`;
  result.delivery_time = time;
}

export function parseQ4RoadOrder(text: string): ParsedOrder {
  const result: ParsedOrder = { ...EMPTY_PARSED_ORDER };
  parseHeader(text, result);

  // Blok Zleceniodawcy stoi między numerem zlecenia a etykietą "Zleceniodawca" (etykieta w tym
  // layoucie idzie PO treści bloku): "Q4Road Sp. z o.o ul. Sportowa 8, 81-300 Gdynia www.q4road.com
  // NIP: 958 170 42 61". Nazwa = wszystko przed adresem ("ul."); reszta to dane do kontrahenta.
  const forwarderBlock = text.match(/\|\s*[A-Za-z0-9/._-]+\s+(.+?)\s+Zleceniodawca\b/i);
  if (forwarderBlock) {
    const block = forwarderBlock[1];
    const [name, rest = ""] = block.split(/\s+(?=ul\.\s)/i);
    result.forwarder = name.trim();
    const nip = block.match(/NIP:\s*([\d\s-]+)/i);
    if (nip) result.forwarder_nip = nip[1].replace(/\D/g, "");
    const street = rest.match(/^(ul\.\s[^,]+)/i);
    if (street) result.forwarder_address = street[1].trim();
    const postalCity = rest.match(/(\d{2}-\d{3})\s+(.+?)(?=\s+www\.|\s+NIP:|$)/i);
    if (postalCity) {
      result.forwarder_postal_code = postalCity[1];
      result.forwarder_city = postalCity[2].trim();
    }
  }

  parseUnloadingRow(text, result);

  const containerType = between(text, /Typ i gestia kontenera:/i, /Numer kontenera:/i);
  if (containerType) {
    const [size, ...rest] = containerType.split(/\s+/);
    result.container_size = size ?? "";
    result.shipping_line = rest.join(" ");
  }
  result.container_number = between(text, /Numer kontenera:/i, /Miejsce odprawy celnej:/i);
  result.customs_location_or_status = between(text, /Miejsce odprawy celnej:/i, /\s(?:Zlecenie|Stawka)\b/i);

  // "3296,00 PLN - płatność 60 dni od daty wpływu faktury i listu przewozowego" — do granicy słowa
  // "Stawka" (etykieta sekcji), NIE końca tekstu.
  const rateMatch = text.match(/([\d\s.]+,\d{2})\s*(PLN|EUR)\s*-\s*płatność\s*(\d+)\s*dni\s*(.+?)\s*Stawka\b/i);
  if (rateMatch) {
    result.rate_amount = parseAmount(rateMatch[1]);
    result.rate_currency = rateMatch[2].toUpperCase();
    result.payment_terms_days = Number(rateMatch[3]);
    result.payment_terms_note = rateMatch[4].trim();
  }
  return result;
}

export function parseQ4RoadWaybill(text: string): ParsedOrder {
  const result: ParsedOrder = { ...EMPTY_PARSED_ORDER };
  parseHeader(text, result);

  result.driver_name = between(text, /Imię i nazwisko:/i, /Dokument tożsamości:/i);
  result.driver_id_number = between(text, /Dokument tożsamości:/i, /Ciągnik \/ Naczepa:/i);
  const plates = between(text, /Ciągnik \/ Naczepa:/i, /Numer telefonu:/i);
  if (plates) {
    const [vehicle, trailer] = plates.split("/").map((p) => p.trim());
    result.vehicle_plate = vehicle ?? "";
    result.trailer_plate = trailer ?? "";
  }
  result.driver_phone = between(text, /Numer telefonu:/i, /\sKierowca\b/i);

  result.container_number = between(text, /Numer kontenera:/i, /Typ kontenera:/i);
  result.container_size = between(text, /Typ kontenera:/i, /Gestia:/i);
  result.shipping_line = between(text, /Gestia:/i, /\sKontener\b/i);

  // "GCT Gdynia" → "GCT". Jeśli w dokumencie jest coś spoza listy, zostawiamy surowy tekst —
  // formularz pokaże go jako dodatkową opcję zamiast zgubić.
  const pickupRaw = between(text, /Miejsce podjęcia kontenera:/i, /Numer wizyty \/ PIN:/i);
  result.pickup_type = matchPickupLocation(pickupRaw) || pickupRaw;
  const pin = between(text, /Numer wizyty \/ PIN:/i, /Booking:/i);
  const booking = between(text, /Booking:/i, /\sPodjęcie\b/i);
  result.pin_booking = pin && booking ? `${pin} / ${booking}` : pin || booking;

  parseUnloadingRow(text, result);
  result.customs_location_or_status = between(text, /Miejsce odprawy celnej:/i, /Nazwa towaru:/i);
  result.goods_name = between(text, /Nazwa towaru:/i, /Waga towaru brutto:/i);
  // "Waga towaru brutto" z listu = waga TOWARU (net_weight_kg zlecenia); brutto zlecenia liczymy jako
  // towar + tara kontenera. Puste pole drukuje się jako sama jednostka ("kg") — bez cyfry to brak wagi.
  result.net_weight_kg = parseWeightKg(between(text, /Waga towaru brutto:/i, /Miejsce złożenia pustego:/i));
  const gross = computeGrossWeightKg(result.net_weight_kg, result.container_size);
  result.gross_weight = gross === null ? "" : String(gross);
  result.submitted_where = between(text, /Miejsce złożenia pustego:/i, /\sRozładunek\b/i);
  return result;
}
