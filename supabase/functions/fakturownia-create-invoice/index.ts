// ============================================================
// fakturownia-create-invoice — wystawia fakturę w Fakturowni dla JEDNEGO lub KILKU zleceń
// ============================================================
// Kopia wzorca z bochanw/DAB/supabase/functions/fakturownia-create-invoice (Panel floty), z inną
// treścią: jedna pozycja na każde zlecenie (ładunek) — tytuł składa appka
// (src/lib/invoice/invoiceTitle.ts) i pokazuje do edycji PRZED wysłaniem; ta funkcja tylko przekazuje.
//
// Kwoty są NETTO (właściciel: "wysyła kwotę z frachtu jako brutto, a to jest netto") — pozycja idzie
// jako `price_net` × 1, Fakturownia sama dolicza VAT wg `tax`.
//
// Token API Fakturowni NIE trafia do appki w przeglądarce — żyje wyłącznie w sekretach projektu
// Supabase (Dashboard → Edge Functions → Secrets): FAKTUROWNIA_SUBDOMAIN, FAKTUROWNIA_API_TOKEN.
// Wdrożenie bez CLI: Dashboard → Edge Functions → Deploy a new function → Via Editor → nazwa
// `fakturownia-create-invoice` → wklejony ten plik → Deploy.
//
// Autoryzacja: domyślna weryfikacja JWT Supabase — każdy zalogowany dyspozytor (świadomie bez
// is_manager(), jak reszta tej appki; patrz CLAUDE.md).
//
// Zabezpieczenie przed dublem: `oid` = id zleceń z naszej bazy + `oid_unique:'yes'` — Fakturownia
// odrzuci drugą fakturę do tego samego zestawu zleceń; appka dodatkowo blokuje zlecenia już
// zafakturowane (fakturownia_invoice_id).
//
// Stawka VAT: 23% dla kontrahenta krajowego (PLN, bez VAT-EU), "np" dla zagranicznego — to samo
// pierwsze przybliżenie co w DAB, do zweryfikowania na pierwszych realnych fakturach.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface InvoiceRequest {
  loadIds?: string[];
  positions?: { title?: string; amountNet?: number }[];
  currency?: string;
  paymentTermsDays?: number | null;
  paymentTermsNote?: string | null;
  sellDate?: string | null;
  buyer?: {
    name?: string;
    nip?: string | null;
    vatEu?: string | null;
    street?: string | null;
    email?: string | null;
  };
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ ok: false, reason: 'method', error: 'Dozwolona jest wyłącznie metoda POST.' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, reason: 'unauthorized', error: 'Brak nagłówka Authorization.' }, 401);

  let body: InvoiceRequest;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: 'bad_request', error: 'Nieprawidłowe zapytanie.' }, 400);
  }

  const loadIds = (body.loadIds || []).map((id) => String(id).trim()).filter(Boolean);
  const positions = (body.positions || []).map((p) => ({ title: (p.title || '').toString().trim(), amountNet: Number(p.amountNet) || 0 }));
  const buyerName = (body.buyer?.name || '').trim();
  if (loadIds.length === 0 || positions.length === 0 || positions.some((p) => !p.title || p.amountNet <= 0) || !buyerName) {
    return json({ ok: false, reason: 'bad_request', error: 'Faktura wymaga zleceń, pozycji z tytułem i dodatnią kwotą netto oraz nazwy kontrahenta.' }, 400);
  }

  const subdomain = Deno.env.get('FAKTUROWNIA_SUBDOMAIN');
  const apiToken = Deno.env.get('FAKTUROWNIA_API_TOKEN');
  if (!subdomain || !apiToken) {
    return json({ ok: false, reason: 'not_configured', error: 'Integracja z Fakturownią nie jest skonfigurowana (brak FAKTUROWNIA_SUBDOMAIN / FAKTUROWNIA_API_TOKEN w sekretach projektu Supabase).' }, 200);
  }

  const currency = (body.currency || 'PLN').toUpperCase();
  const isForeign = currency !== 'PLN' || !!(body.buyer?.vatEu || '').trim();
  const tax = isForeign ? 'np' : 23;
  // Data wystawienia = DZIŚ; data sprzedaży = z appki (dyspozytor wybiera, bo ładunki mogą być z
  // kilku dni); termin płatności = dziś + dni z warunku kontrahenta/dokumentu.
  const issueDate = new Date().toISOString().slice(0, 10);
  const sellDate = (body.sellDate || issueDate).slice(0, 10);
  const days = Number(body.paymentTermsDays);
  const paymentTo = Number.isFinite(days) && days > 0 ? addDays(issueDate, days) : undefined;

  const invoicePayload: Record<string, unknown> = {
    kind: 'vat',
    issue_date: issueDate,
    sell_date: sellDate,
    currency,
    payment_type: 'transfer',
    oid: loadIds.join('+'),
    oid_unique: 'yes',
    buyer_name: buyerName,
    positions: positions.map((p) => ({ name: p.title, quantity: 1, quantity_unit: 'usł.', price_net: p.amountNet, tax })),
  };
  const note = (body.paymentTermsNote || '').trim();
  if (note) invoicePayload.description = `Termin płatności: ${days > 0 ? `${days} dni ` : ''}${note}`;
  if ((body.buyer?.nip || '').trim()) invoicePayload.buyer_tax_no = body.buyer!.nip!.trim();
  if ((body.buyer?.street || '').trim()) invoicePayload.buyer_street = body.buyer!.street!.trim();
  if ((body.buyer?.email || '').trim()) invoicePayload.buyer_email = body.buyer!.email!.trim();
  if (paymentTo) invoicePayload.payment_to = paymentTo;

  try {
    const res = await fetch(`https://${subdomain}.fakturownia.pl/invoices.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_token: apiToken, invoice: invoicePayload }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.id) {
      const detail = data ? JSON.stringify(data).slice(0, 400) : await res.text().catch(() => '');
      return json({ ok: false, reason: 'api_error', error: `Fakturownia odpowiedziała błędem (HTTP ${res.status}). ${detail}` }, 200);
    }
    const viewUrl = data.token
      ? `https://${subdomain}.fakturownia.pl/invoice/${data.token}`
      : `https://${subdomain}.fakturownia.pl/invoices/${data.id}`;
    return json({
      ok: true,
      invoice: {
        id: data.id,
        number: data.number || '',
        issueDate: data.issue_date || issueDate,
        paymentTo: data.payment_to || paymentTo || null,
        viewUrl,
      },
    });
  } catch (e) {
    return json({ ok: false, reason: 'network', error: 'Nie udało się połączyć z Fakturownią: ' + (e as Error).message }, 200);
  }
});
