-- ============================================================
-- 0019 — ślad po agencie sprawdzającym statusy w Baltic Hub (rozszerzenie do Chrome).
--
-- PO CO: od tej zmiany terminal odpytuje PRZEGLĄDARKA DYSPOZYTORA, a nie serwer (baltichub.com
-- stoi za Cloudflare i reCAPTCHĄ — sprawdzone). Przeglądarka bywa zamknięta, rozszerzenie bywa
-- wyłączone albo wylogowane, a wtedy statusy po prostu przestają się odświeżać. Bez tej tabeli
-- działoby się to W CISZY: dyspozytor patrzyłby na wczorajszy stan przekonany, że jest dzisiejszy.
-- Ta sama zasada co przy skrzynce mailowej — martwy odczyt ma być WIDAĆ.
--
-- Wiersz per instalacja rozszerzenia (`agent_id` losowany raz przy pierwszym uruchomieniu), nie
-- per użytkownik: jeden dyspozytor może mieć dwa komputery, a dwóch dyspozytorów jeden wspólny.
--
-- Zapisuje WYŁĄCZNIE funkcja brzegowa (service_role, omija RLS). Appka ma czytać, nie pisać —
-- stąd jedna polityka na SELECT i brak polityk zapisu.
-- ============================================================

create table if not exists public.bhub_agent_state (
  agent_id text primary key,
  label text,
  user_id uuid references auth.users (id) on delete set null,
  last_seen_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,
  checked_count integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.bhub_agent_state is
  'Ostatni kontakt rozszerzenia sprawdzającego statusy Baltic Hub. Wiersz per instalacja.';

alter table public.bhub_agent_state enable row level security;

-- Wzorzec "wymaga logowania" z reszty appki: widzi każdy zalogowany, nigdy `anon`.
drop policy if exists "bhub_agent_state - wymaga logowania" on public.bhub_agent_state;
create policy "bhub_agent_state - wymaga logowania"
  on public.bhub_agent_state
  for select
  to authenticated
  using (true);

grant select on public.bhub_agent_state to authenticated;

-- Realtime: pasek Zestawienia pokazuje "ostatnio sprawdzone X minut temu" bez odświeżania strony.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bhub_agent_state'
  ) then
    alter publication supabase_realtime add table public.bhub_agent_state;
  end if;
end $$;
