import { EMPTY_PARSED_ORDER, type ParsedOrder } from "@/types/parsedOrder";

// Parser szablonu Q4Road ("ZLECENIE SPEDYCYJNE" / q4road.com) — pierwszy znany klient appki,
// zbudowany i zweryfikowany na przykładowym zleceniu (ZD/1797/6/2026, import, kontener
// NYKU9911861). Regexy dopasowane do FAKTYCZNEGO tekstu wyciąganego przez pdf.js z tego layoutu
// (dwukolumnowy nagłówek Zleceniodawca/Zleceniobiorca, tabela "Miejsca rozładunku") — kolejność
// tekstu w warstwie PDF-a odpowiada kolejności czytania, ale każde dopasowanie jest niewymagające
// (grupy `.+?` między znanymi etykietami), żeby drobne różnice w kolejnym zleceniu tego samego
// klienta (inny adres, więcej miejsc rozładunku) nie wywaliły całego parsera na null.

export function detectQ4Road(text: string): boolean {
  return /q4road/i.test(text);
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, "");
  // Polski zapis "3 296,00" — przecinek jako separator dziesiętny, kropka/spacja jako tysięczny.
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function parseQ4Road(text: string): ParsedOrder {
  const result: ParsedOrder = { ...EMPTY_PARSED_ORDER };

  // "Import | ZD/1797/6/2026" — kierunek i numer zlecenia w jednym miejscu.
  const headerMatch = text.match(/\b(Import|Eksport|Export)\s*\|\s*([A-Za-z0-9/._-]+)/i);
  if (headerMatch) {
    result.direction = headerMatch[1].toLowerCase() === "import" ? "I" : "E";
    result.order_number = headerMatch[2];
  }

  // Blok Zleceniodawcy stoi między numerem zlecenia a etykietą "Zleceniodawca" (etykieta w tym
  // layoucie idzie PO treści bloku, nie przed nią). Sama nazwa firmy to wszystko przed adresem
  // (zaczynającym się od "ul.").
  const forwarderBlock = text.match(/\|\s*[A-Za-z0-9/._-]+\s+(.+?)\s+Zleceniodawca\b/i);
  if (forwarderBlock) {
    result.forwarder = forwarderBlock[1].split(/\s+ul\.\s/i)[0].trim();
  }

  // Pierwszy wiersz tabeli "Miejsca rozładunku": firma + adres, potem data i godzina.
  // Świadomie tylko wiersz "1" — appka dziś obsługuje jedno miejsce rozładunku na rekord
  // (patrz komentarz w Edge Function o tym samym ograniczeniu).
  const rowMatch = text.match(/Uwagi\s+1\s+(.+?)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})/i);
  if (rowMatch) {
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

  const containerTypeMatch = text.match(/Typ i gestia kontenera:\s*(.+?)\s*Numer kontenera:/i);
  if (containerTypeMatch) {
    const [size, ...rest] = containerTypeMatch[1].trim().split(/\s+/);
    result.container_size = size ?? "";
    result.shipping_line = rest.join(" ");
  }

  const containerNumberMatch = text.match(/Numer kontenera:\s*(.+?)\s*Miejsce odprawy celnej:/i);
  if (containerNumberMatch) result.container_number = containerNumberMatch[1].trim();

  const customsMatch = text.match(/Miejsce odprawy celnej:\s*(.+?)(?:\s+Zlecenie\b|\s+Stawka\b|$)/i);
  if (customsMatch) result.customs_location_or_status = customsMatch[1].trim();

  // "3296,00 PLN - płatność 60 dni od daty wpływu faktury i listu przewozowego" — terminuje na
  // granicy słowa "Stawka" (etykieta sekcji), NIE końcem tekstu: appka skleja wszystkie strony
  // PDF-a w jeden ciąg, więc po "Stawka" idzie dalej strona 2 (Ogólne warunki zlecenia).
  const rateMatch = text.match(/([\d\s.]+,\d{2})\s*(PLN|EUR)\s*-\s*płatność\s*(\d+)\s*dni\s*(.+?)\s*Stawka\b/i);
  if (rateMatch) {
    result.rate_amount = parseAmount(rateMatch[1]);
    result.rate_currency = rateMatch[2].toUpperCase();
    result.payment_terms_days = Number(rateMatch[3]);
    result.payment_terms_note = rateMatch[4].trim();
  }

  return result;
}
