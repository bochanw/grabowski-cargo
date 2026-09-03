-- ============================================================
-- Załączniki przy zleceniu (właściciel: "po imporcie zleceń oryginalne PDF zostaną zachowane jako
-- załączniki — więc analogicznie jak dogram POD/CMR/potwierdzenie dostawy, program będzie dodawać
-- także pole inne").
--
-- Plik idzie do prywatnego bucketa Storage, a w bazie zostaje metryka + ścieżka — ten sam układ co
-- przy załącznikach maili (migracja 0010). `bucket` jest kolumną, bo dokument zlecenia może już
-- LEŻEĆ w `order-emails` (przyszedł mailem i został tam zapisany przez `mail-poll`) — wtedy
-- podpinamy istniejący plik zamiast kopiować go drugi raz.
--
-- `on delete cascade`: skasowanie zlecenia kasuje wiersze dokumentów. Same pliki w Storage kasuje
-- appka PRZED usunięciem zlecenia (useDeleteLoad) — Postgres nie sięga do Storage.
-- ============================================================

create table if not exists public.load_documents (
  id            uuid primary key default gen_random_uuid(),
  load_id       uuid not null references public.loads (id) on delete cascade,

  -- Rodzaj dokumentu. "inne" jest workiem na wszystko, o co właściciel prosił wprost — nowa
  -- wartość wymaga migracji, ale dopisanie jej to jedna linijka w tym CHECK-u i w
  -- src/types/loadDocument.ts (etykiety zna appka).
  kind          text not null default 'inne'
                check (kind in ('zlecenie', 'list_przewozowy', 'pod_cmr', 'inne')),

  file_name     text,
  mime_type     text,
  size_bytes    bigint,
  bucket        text not null default 'load-documents',
  storage_path  text not null,

  -- Czym odczytano ten plik przy imporcie ("szablon Q4Road", "odczyt przez Claude") — przy
  -- rozjeździe danych widać, który dokument co wniósł. Puste dla dokumentów dopiętych bez odczytu
  -- (POD, CMR, potwierdzenie dostawy).
  parse_source  text,
  uploaded_by   text,

  created_at    timestamptz not null default now()
);

create index if not exists load_documents_load_idx on public.load_documents (load_id, created_at);

alter table public.load_documents enable row level security;

-- Wzorzec "wymaga logowania" jak w reszcie appki: dyspozytorzy dopinają i kasują dokumenty sami.
drop policy if exists "wymaga logowania" on public.load_documents;
create policy "wymaga logowania"
on public.load_documents as permissive for all to authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- Storage
-- ------------------------------------------------------------
-- Prywatny bucket — pliki tylko dla zalogowanych, przez podpisany URL (jak `order-emails`).
insert into storage.buckets (id, name, public)
values ('load-documents', 'load-documents', false)
on conflict (id) do nothing;

drop policy if exists "zalogowany czyta dokumenty zlecen" on storage.objects;
create policy "zalogowany czyta dokumenty zlecen"
on storage.objects as permissive for select to authenticated
using (bucket_id = 'load-documents');

-- Wgrywanie i kasowanie idzie WPROST z przeglądarki (import zlecenia, "Dokumenty" przy wierszu),
-- więc w odróżnieniu od `order-emails` (tam pisze wyłącznie service_role pollera) potrzebne są
-- polityki insert/update/delete.
drop policy if exists "zalogowany wgrywa dokumenty zlecen" on storage.objects;
create policy "zalogowany wgrywa dokumenty zlecen"
on storage.objects as permissive for insert to authenticated
with check (bucket_id = 'load-documents');

drop policy if exists "zalogowany podmienia dokumenty zlecen" on storage.objects;
create policy "zalogowany podmienia dokumenty zlecen"
on storage.objects as permissive for update to authenticated
using (bucket_id = 'load-documents') with check (bucket_id = 'load-documents');

drop policy if exists "zalogowany kasuje dokumenty zlecen" on storage.objects;
create policy "zalogowany kasuje dokumenty zlecen"
on storage.objects as permissive for delete to authenticated
using (bucket_id = 'load-documents');

-- ------------------------------------------------------------
-- Realtime
-- ------------------------------------------------------------
-- Licznik "Dokumenty (N)" przy wierszu ma się zmieniać bez odświeżania — także wtedy, gdy plik
-- dopiął ktoś inny.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'load_documents'
  ) then
    alter publication supabase_realtime add table public.load_documents;
  end if;
end $$;
