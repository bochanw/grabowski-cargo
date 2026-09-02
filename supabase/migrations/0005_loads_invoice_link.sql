-- ============================================================
-- Powiązanie zlecenia z fakturą wystawioną w Fakturowni (funkcja brzegowa
-- fakturownia-create-invoice). Numer faktury idzie do istniejącej kolumny `invoice_number` (BC
-- z arkusza), termin do `invoice_payment_date` (BF); tu dochodzi to, czego arkusz nie miał:
-- id faktury w Fakturowni (blokada ponownego wystawienia po stronie appki), link do podglądu
-- i data wystawienia.
-- Odpalić RĘCZNIE w SQL Editor projektu Grabowskiego, potem odświeżyć cache PostgREST.
-- ============================================================

alter table public.loads
  add column if not exists fakturownia_invoice_id bigint,
  add column if not exists invoice_url text,
  add column if not exists invoice_issued_at date;

notify pgrst, 'reload schema';
