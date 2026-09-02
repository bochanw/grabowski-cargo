// ============================================================
// fakturownia-create-invoice — wystawia fakturę w Fakturowni dla zlecenia z Zestawienia
// ============================================================
// Kopia wzorca z bochanw/DAB/supabase/functions/fakturownia-create-invoice (Panel floty), z inną
// treścią pozycji: właściciel chce w tytule "Transport kontenera <nr>, na trasie <trasa>, nr
// zlecenia <nr>" — trasę i tytuł składa appka (src/lib/invoice/invoiceTitle.ts) i pokazuje do
// edycji PRZED wysłaniem; ta funkcja dostaje gotowy tytuł i tylko go przekazuje.
//
// Token API Fakturowni NIE trafia do appki w przeglądarce — żyje wyłącznie w sekretach projektu
// Supabase. Konfiguracja (Dashboard → Project Settings → Edge Functions → Secrets, albo CLI):
//   supabase secrets set FAKTUROWNIA_SUBDOMAIN=<subdomena> FAKTUROWNIA_API_TOKEN=<token> --project-ref itlgexjhznjsbonzdxyg
//   supabase functions deploy fakturownia-create-invoice --project-ref itlgexjhznjsbonzdxyg
// Subdomena = "twojafirma" z twojafirma.fakturownia.pl; token: Ustawienia → Ustawienia konta →
// Integracja → Kod autoryzacyjny API. Bez sekretów funkcja zwraca jawny `reason:'not_configured'`.
//
// Autoryzacja: domyślna weryfikacja JWT Supabase — każdy zalogowany dyspozytor (świadomie bez
// is_manager(), jak parse-order-pdf; patrz CLAUDE.md). To wystawia PRAWDZIWE faktury — jeśli
// właściciel zechce ograniczyć do managera, to osobna decyzja.
//
// Zabezpieczenie przed dublem: `oid` = id zlecenia z naszej bazy + `oid_unique:'yes'` — Fakturownia
// odrzuci drugą fakturę do tego samego zlecenia, nawet gdyby appka o tym zapomniała.
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
  loadId?: string;
  orderNumber?: string;
  title?: string;
  amount?: number;
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

  const loadId = (body.loadId || '').toString().trim();
  const title = (body.title || '').toString().trim();
  const amount = Number(body.amount) || 0;
  const buyerName = (body.buyer?.name || '').trim();
  if (!loadId || !title || amount <= 0 || !buyerName) {
    return json({ ok: false, reason: 'bad_request', error: 'Faktura wymaga zlecenia, tytułu, dodatniej kwoty i nazwy kontrahenta.' }, 400);
  }

  const subdomain = Deno.env.get('FAKTUROWNIA_SUBDOMAIN');
  const apiToken = Deno.env.get('FAKTUROWNIA_API_TOKEN');
  if (!subdomain || !apiToken) {
    return json({ ok: false, reason: 'not_configured', error: 'Integracja z Fakturownią nie jest skonfigurowana (brak FAKTUROWNIA_SUBDOMAIN / FAKTUROWNIA_API_TOKEN w sekretach projektu Supabase).' }, 200);
  }

  const currency = (body.currency || 'PLN').toUpperCase();
  const isForeign = currency !== 'PLN' || !!(body.buyer?.vatEu || '').trim();
  const tax = isForeign ? 'np' : 23;
  // Data wystawienia = DZIŚ; data sprzedaży = rozładunek/załadunek (jak w DAB — pomylenie tych dat
  // było tam realnym błędem). Termin płatności = dziś + dni z warunku kontrahenta/dokumentu.
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
    oid: loadId,
    oid_unique: 'yes',
    buyer_name: buyerName,
    positions: [{ name: title, quantity: 1, quantity_unit: 'usł.', total_price_gross: amount, tax }],
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
