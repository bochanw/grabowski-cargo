-- ============================================================
-- Dodaje warunek płatności (termin liczony w dniach od zdarzenia, np.
-- "60 dni od daty wpływu faktury i listu przewozowego" ze zlecenia
-- spedycyjnego) — czym innym niż konkretna DATA płatności
-- (subcontractor_payment_due_date/invoice_payment_date, które appka zna
-- dopiero po ustaleniu konkretnego terminu). Odpalić RĘCZNIE, PO
-- 0001_loads_schema_rls.sql, na tym samym projekcie Supabase Grabowskiego.
--
-- Dwie pozostałe pola z pierwszego ręcznie zaimportowanego zlecenia
-- (Q4Road, ZD/1797/6/2026) NIE potrzebują nowych kolumn — potwierdzone
-- z właścicielem:
-- - "Miejsce odprawy celnej" → istniejące `customs_status` (pole ma
--   pomieścić i status, i miejsce odprawy, nie tylko jedno z dwóch).
-- - "Stawka" (uzgodniona kwota od spedytora) → istniejące `invoice_amount`,
--   bez rozróżniania "uzgodniona stawka" vs "kwota na wystawionej fakturze".
-- ============================================================

alter table public.loads
  add column if not exists payment_terms_days numeric,   -- liczba dni (np. 60)
  add column if not exists payment_terms_note text;       -- od czego liczony termin (np. "od daty wpływu faktury i listu przewozowego")
