-- ============================================================
-- Kontrahenci (spedytorzy/zleceniodawcy) — właściciel: "skonfigurujemy na sztywno termin
-- płatności, nr NIP i inne dane potrzebne do wysyłki faktur bezpośrednio do Fakturowni".
-- Pola dobrane pod kontrakt faktury w Fakturowni (patrz
-- bochanw/DAB/supabase/functions/fakturownia-create-invoice: buyer_name, buyer_tax_no,
-- buyer_street, buyer_email, payment_to, currency/VAT-EU) — żeby przyszła wysyłka faktury miała
-- wszystko w jednym rekordzie, bez dopytywania dyspozytora.
--
-- Odpalić RĘCZNIE w SQL Editor projektu Grabowskiego, PO 0001-0003, potem odświeżyć cache
-- PostgREST (jak przy każdej ręcznej migracji).
-- ============================================================

create table if not exists public.contractors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,        -- nazwa na fakturze (buyer_name)
  -- Nazwy, pod jakimi ten kontrahent występuje w dokumentach (np. "Q4Road Sp. z o.o", "Q4Road") —
  -- import dopasowuje spedytora z PDF-a po `name` ALBO po którymś aliasie, bez rozróżniania
  -- wielkości liter i interpunkcji.
  aliases             text[] not null default '{}',
  nip                 text,                 -- buyer_tax_no, same cyfry
  vat_eu              text,                 -- numer VAT-EU dla kontrahenta zagranicznego (Fakturownia: stawka "np")
  address             text,                 -- ulica i numer (buyer_street)
  postal_code         text,
  city                text,
  email               text,                 -- buyer_email — dokąd Fakturownia wyśle fakturę
  payment_terms_days  numeric,              -- domyślny termin płatności w dniach
  payment_terms_note  text,                 -- od czego liczony (np. "od daty wpływu faktury i listu przewozowego")
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.contractors enable row level security;

drop policy if exists "wymaga logowania" on public.contractors;
create policy "wymaga logowania"
on public.contractors as permissive for all to authenticated using (true) with check (true);

-- Ten sam trigger updated_at co na loads (funkcja z 0001 jest generyczna — ustawia new.updated_at).
drop trigger if exists contractors_set_updated_at on public.contractors;
create trigger contractors_set_updated_at
before update on public.contractors
for each row execute function public.set_loads_updated_at();

-- Powiązanie zlecenia z kontrahentem. `forwarder` (tekst z dokumentu) ZOSTAJE — to, co spedytor
-- sam o sobie napisał; `contractor_id` to nasze, skonfigurowane dane do faktury. Usunięcie
-- kontrahenta nie kasuje zleceń, tylko zrywa powiązanie.
alter table public.loads
  add column if not exists contractor_id uuid references public.contractors (id) on delete set null;

create index if not exists loads_contractor_id_idx on public.loads (contractor_id);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contractors'
  ) then
    alter publication supabase_realtime add table public.contractors;
  end if;
end $$;
