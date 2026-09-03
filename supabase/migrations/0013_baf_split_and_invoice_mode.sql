-- ============================================================
-- BAF (dodatek paliwowy) rozbity na stawkę bazową i dodatek + sposób fakturowania per kontrahent.
--
-- Zgłoszenie właściciela po imporcie przez Claude: "w jednym zleceniu było, że stawka już jest z
-- BAF 13% — wtedy program powinien, znając stawkę, rozdzielić, ile wynosi stawka bazowa, ile BAF
-- (przy wpisanym będziemy wypychać do faktur albo stawkę z BAF razem, albo BAF jako oddzielną
-- pozycję na fakturze — do konfiguracji via klient)".
--
-- Arkusz klienta miał już %BAF (AY), Kwotę BAF (AZ) i SUMĘ (BA) — brakowało samej stawki BAZOWEJ,
-- czyli tego, od czego BAF jest liczony. Stąd JEDNA nowa kolumna zamiast przeciążania istniejących:
--   freight_base_amount + baf_amount = total_amount (i to samo idzie na fakturę).
-- ============================================================

alter table public.loads
  add column if not exists freight_base_amount numeric;

comment on column public.loads.freight_base_amount is
  'Stawka bazowa (fracht bez BAF-u). freight_base_amount + baf_amount = total_amount; liczone w src/lib/invoice/baf.ts.';

-- Sposób wypchnięcia BAF-u na fakturę jest cechą KONTRAHENTA (jeden chce jedną pozycję, drugi
-- rozbicie), nie pojedynczego zlecenia. Domyślnie 'combined' — tak appka fakturowała do tej pory,
-- więc migracja niczego nie zmienia istniejącym kontrahentom.
alter table public.contractors
  add column if not exists baf_invoice_mode text not null default 'combined';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contractors_baf_invoice_mode_check'
  ) then
    alter table public.contractors
      add constraint contractors_baf_invoice_mode_check
      check (baf_invoice_mode in ('combined', 'separate'));
  end if;
end $$;

comment on column public.contractors.baf_invoice_mode is
  'combined = stawka razem z BAF-em jako jedna pozycja faktury; separate = osobna pozycja "BAF".';
