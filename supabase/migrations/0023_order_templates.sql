-- ============================================================
-- AUTO-NAUKA SZABLONÓW ZLECEŃ — nauczone układy dokumentów per spedytor
--
-- Właściciel: "pomyśl jak to zrobić, żeby automatycznie odczyt zlecenia jednorazowy przez AI był
-- traktowany jako znany szablon, taka auto-nauka". Chodzi o koszt: pierwsze zlecenie od nowego
-- spedytora czyta Claude (płatnie), a każde następne ma czytać darmowy parser wyuczony z tamtego.
--
-- DLACZEGO W BAZIE, A NIE W KODZIE (jak q4road.ts): szablon powstaje w trakcie pracy dyspozytora,
-- a ma zadziałać NATYCHMIAST u wszystkich i w `mail-poll`. Gdyby siedział w kodzie, każdy nowy
-- spedytor wymagałby wdrożenia — czyli dokładnie tego, czego właściciel chce uniknąć. Ręcznie
-- pisane szablony w `src/lib/orderTemplates/` ZOSTAJĄ i mają pierwszeństwo: są dokładniejsze,
-- bo pisał je człowiek patrzący na dokument.
--
-- CO SIEDZI W `rules` (jsonb): pole → {before, after, kind, format, occurrence}. Kształt zna
-- WYŁĄCZNIE appka (src/lib/orderTemplates/learn.ts), baza go nie waliduje — dokładnie jak przy
-- `user_view_settings`. Dzięki temu ulepszenie reguł nie wymaga migracji.
--
-- STANY (`status`) — wprost z decyzji właściciela "dopiero po drugim takim dokumencie":
--   kandydat  — mamy JEDEN dokument-wzorzec (tekst + zatwierdzone pola), reguł jeszcze nie ma,
--               bo z jednego dokumentu nie da się odróżnić etykiety od sąsiedniej wartości;
--   aktywny   — drugi dokument tego układu potwierdził kotwice i szablon odtworzył komplet
--               kluczowych pól; dopiero taki zastępuje płatny odczyt;
--   wycofany  — dyspozytor go wyłączył albo appka wycofała po powtarzających się poprawkach.
--
-- `sample_text` (tekst dokumentu-wzorca) zostaje przy szablonie także po aktywacji: dzięki temu
-- kolejny dokument może DOUCZYĆ pola, których w pierwszej parze nie było (puste rubryki), bez
-- proszenia kogokolwiek o cokolwiek.
-- ============================================================

create table if not exists public.order_templates (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  forwarder_name text,
  -- NIP jest drugim, niezależnym warunkiem dopasowania: same etykiety bywają podobne u dwóch
  -- spedytorów korzystających z tego samego programu do zleceń.
  forwarder_nip  text,
  doc_kind       text not null default 'inne' check (doc_kind in ('zlecenie', 'list_przewozowy', 'inne')),
  -- "Odcisk palca" układu: zbiór etykiet dokumentu. Dwa zlecenia od tego samego spedytora mają te
  -- same rubryki i inne wartości, więc porównujemy rubryki.
  labels         text[] not null default '{}',
  rules          jsonb not null default '{}'::jsonb,
  status         text not null default 'kandydat' check (status in ('kandydat', 'aktywny', 'wycofany')),
  confirmations  integer not null default 1,
  uses           integer not null default 0,
  -- pole → ile razy dyspozytor poprawił to, co odczytał szablon. Dwie poprawki = reguła wylatuje.
  corrections    jsonb not null default '{}'::jsonb,
  sample_text    text,
  sample_values  jsonb,
  learned_from   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  activated_at   timestamptz,
  last_used_at   timestamptz
);

create index if not exists order_templates_status_idx on public.order_templates (status);
create index if not exists order_templates_nip_idx on public.order_templates (forwarder_nip);

alter table public.order_templates enable row level security;

-- Ten sam wzorzec co w reszcie appki: "wymaga logowania". Szablony są WSPÓLNE dla wszystkich
-- dyspozytorów (inaczej niż user_view_settings, które są prywatne) — nauka jednej osoby ma
-- oszczędzać pracę i pieniądze całej firmie.
drop policy if exists "wymaga logowania" on public.order_templates;
create policy "wymaga logowania"
on public.order_templates as permissive for all to authenticated using (true) with check (true);

drop trigger if exists order_templates_set_updated_at on public.order_templates;
create trigger order_templates_set_updated_at
before update on public.order_templates
for each row execute function public.set_loads_updated_at();

-- Nauka jednego dyspozytora ma być widoczna u pozostałych bez odświeżania strony.
alter publication supabase_realtime add table public.order_templates;
