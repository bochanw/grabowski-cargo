-- ============================================================
-- 0033 — KTÓRĄ DROGĄ pytamy każdy terminal o status kontenera.
--
-- Reguła właściciela wprost: „BHub i strony wymagające logowania — wtyczka; strony publiczne bez
-- logowania — natywna obsługa (o ile będzie możliwa), z dobudowaną funkcjonalnością po stronie
-- wtyczki, gdyby się wysypało".
--
-- Zmierzone, nie założone (odpowiedzi w `supabase/functions/bhub-status/fixtures/*.html`):
--   BHub  — Cloudflare + reCAPTCHA. Zwykły fetch dostaje 403 na CAŁEJ domenie. ZOSTAJE wtyczka.
--   BCT   — publiczny formularz ASP.NET. GET po `__RequestVerificationToken`, POST, pełna karta.
--   GCT   — publiczny formularz PRADO. GET po `PRADO_PAGESTATE`, POST, wiersz na kontener.
--
-- PO CO TABELA, A NIE STAŁA W KODZIE: to jest właśnie owo „zabezpieczenie, gdyby się wysypało".
-- Gdy BCT albo GCT zacznie się bronić przed automatami (albo zmieni formularz), przestawienie
-- jednego wiersza na `wtyczka` wraca do drogi przez przeglądarkę dyspozytora — bez wdrożenia
-- funkcji i bez aktualizacji rozszerzenia na każdym komputerze. Rozszerzenie NIE TRACI żadnej
-- umiejętności: dalej umie wszystkie trzy terminale, tylko w normalnym cyklu nie dostaje tych,
-- które obsługuje serwer.
--
-- Wiersz `BHub` też tu jest, choć dziś nie ma wyboru: gdyby terminal kiedyś dał API, zmienia się
-- wartość w tabeli, a nie kształt kodu.
-- ============================================================

create table if not exists public.terminal_sources (
  terminal text primary key check (terminal in ('BHub', 'BCT', 'GCT')),
  -- `serwer`  — pobiera funkcja brzegowa `bhub-status` (cron co 15 minut, bez udziału człowieka),
  -- `wtyczka` — pobiera rozszerzenie do Chrome z przeglądarki dyspozytora.
  mode text not null check (mode in ('serwer', 'wtyczka')),
  note text,
  updated_at timestamptz not null default now()
);

comment on table public.terminal_sources is
  'Którą drogą odpytujemy dany terminal o statusy: z serwera czy przez rozszerzenie do Chrome.';

insert into public.terminal_sources (terminal, mode, note) values
  ('BHub', 'wtyczka', 'Cloudflare + reCAPTCHA — zwykły fetch dostaje 403 na całej domenie.'),
  ('BCT',  'serwer',  'Publiczny formularz ASP.NET, bez logowania. Wtyczka zostaje jako zabezpieczenie.'),
  ('GCT',  'serwer',  'Publiczny formularz PRADO, bez logowania. Wtyczka zostaje jako zabezpieczenie.')
on conflict (terminal) do nothing;

alter table public.terminal_sources enable row level security;

-- Wzorzec „wymaga logowania" z reszty appki: widzi każdy zalogowany, nigdy `anon`.
drop policy if exists "terminal_sources - wymaga logowania" on public.terminal_sources;
create policy "terminal_sources - wymaga logowania"
  on public.terminal_sources for select to authenticated using (true);

-- Przestawienie drogi ma być kliknięciem dyspozytora w chwili awarii, a nie zgłoszeniem do
-- programisty — stąd UPDATE dla zalogowanych. INSERT/DELETE świadomie NIE: lista terminali
-- zmienia się razem z kodem, który potrafi je czytać.
drop policy if exists "terminal_sources - przestawianie drogi" on public.terminal_sources;
create policy "terminal_sources - przestawianie drogi"
  on public.terminal_sources for update to authenticated using (true) with check (true);

grant select, update on public.terminal_sources to authenticated;

-- Realtime: przestawienie drogi u jednego dyspozytora ma być od razu widoczne u pozostałych.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'terminal_sources'
  ) then
    alter publication supabase_realtime add table public.terminal_sources;
  end if;
end $$;

-- ------------------------------------------------------------
-- Harmonogram. Wzorzec i uzasadnienie jak przy `mail-poll` (0012/0022): `verify_jwt = false`,
-- a funkcja sprawdza sama nagłówek `x-ingest-secret` czytany z Vaultu.
--
-- ŚWIADOMIE TEN SAM SEKRET `INGEST_SECRET`, co skrzynka mailowa: jest już wpisany w Vault I w
-- sekretach Edge Functions (skrzynka działa), więc odczyt statusów rusza od razu, bez czekania,
-- aż właściciel cokolwiek wklei. MCP nie umie ustawiać sekretów, więc każdy nowy sekret oznacza
-- ręczny krok i funkcję, która do tego czasu milczy.
--
-- Co 15 minut, bo tyle wynosi cykl uzgodniony z właścicielem. Okno „dni robocze 6-18 czasu
-- warszawskiego" pilnuje FUNKCJA (shared/schedule.ts), nie cron: reguła zna polskie święta,
-- a cron chodzi w UTC i latem rozjechałby się o godzinę.
-- ------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('statusy-terminali-co-15-min')
where exists (select 1 from cron.job where jobname = 'statusy-terminali-co-15-min');

select cron.schedule(
  'statusy-terminali-co-15-min',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url := 'https://itlgexjhznjsbonzdxyg.supabase.co/functions/v1/bhub-status',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ingest-secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'INGEST_SECRET' limit 1),
        ''
      )
    ),
    body := '{"action":"cykl"}'::jsonb,
    -- Jeden przebieg pyta terminale po kolei (BCT po jednym kontenerze), a sama funkcja pilnuje
    -- swojego budżetu czasu i resztę zostawia na kolejny kwadrans.
    timeout_milliseconds := 120000
  );
  $cron$
);
