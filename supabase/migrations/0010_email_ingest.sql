-- ============================================================
-- Automatyczny odczyt zleceń ze skrzynki Gmail (właściciel: "program śledzi maile — nawet jak
-- klient dośle informacje w treści/dodatkowym to program to zobaczy; nr zlecenia jest unikalny").
--
-- Klientów jest wielu i lista NIE jest zamknięta, więc nie ma tu żadnej listy dozwolonych
-- nadawców — o tym, czy mail w ogóle trafi do modelu, decyduje `gmail-poll` na podstawie treści
-- (załącznik PDF / numer zlecenia z bazy / odpowiedź w znanym wątku), nie tożsamości nadawcy.
--
-- KONTRAKT, ten sam co przy ręcznym imporcie: NIC nie zapisuje się samo do `loads`. Mail ląduje
-- w kolejce ("Skrzynka" w UI) jako PROPOZYCJA, a zlecenie tworzy/aktualizuje dopiero dyspozytor
-- kliknięciem. Dzięki temu pomyłka modelu ma ograniczony koszt — nie wchodzi cicho do bazy ani
-- na fakturę.
--
-- Konto to zwykły @gmail.com, więc odczyt idzie po IMAP-ie na hasło aplikacji (Gmail API odpada:
-- zakres gmail.readonly jest "restricted", a apka bez audytu CASA dostaje token wygasający co
-- 7 dni). Zweryfikowane na tym projekcie: Edge Function ZWYCZAJNIE łączy się z imap.gmail.com:993
-- (Deno.connectTls, handshake 23 ms) — blokada Supabase dotyczy tylko portów SMTP 25/465/587.
--
-- Do zaaplikowania przez MCP (apply_migration), potem `notify pgrst, 'reload schema'`.
-- ============================================================

-- ------------------------------------------------------------
-- Maile
-- ------------------------------------------------------------
create table if not exists public.email_messages (
  id                uuid primary key default gen_random_uuid(),

  -- Nagłówek Message-ID. UNIQUE jest tu jedynym mechanizmem odporności pollera na powtórki:
  -- restart funkcji, przestawiony UID, ponowne odpytanie tego samego okna — wszystko kończy się
  -- konfliktem na tym indeksie zamiast duplikatem w Skrzynce.
  message_id        text not null unique,
  imap_uid          bigint,

  -- In-Reply-To + References. Odpowiedź w wątku dziedziczy zlecenie nawet wtedy, gdy w jej treści
  -- nie ma już numeru zlecenia ("ok, potwierdzam") — to jest właśnie wymóg "dośle informację w
  -- treści i program to zobaczy".
  thread_refs       text[] not null default '{}',

  from_email        text,
  from_name         text,
  subject           text,
  body_text         text,
  received_at       timestamptz,

  --   new      — do przejrzenia przez dyspozytora (nowe zlecenie albo zmiana do istniejącego)
  --   ignored  — prefiltr uznał, że to nie dotyczy zleceń; model NIE był wołany
  --   accepted — dyspozytor utworzył/zaktualizował zlecenie
  --   rejected — dyspozytor odrzucił
  --   error    — odczyt się wywalił; treść błędu w `error`, mail zostaje do ręcznego obejrzenia
  status            text not null default 'new'
                    check (status in ('new', 'ignored', 'accepted', 'rejected', 'error')),

  -- Niepuste = mail dotyczy JUŻ ISTNIEJĄCEGO zlecenia (dopięcie/zmiana), puste = kandydat na nowe.
  -- `on delete set null`: skasowanie zlecenia nie kasuje historii maili.
  matched_load_id   uuid references public.loads (id) on delete set null,
  match_reason      text,

  -- Pola wyciągnięte z maila i załączników, w kształcie ParsedOrder (src/types/parsedOrder.ts).
  -- jsonb, nie kolumny: kształt zna wyłącznie appka, więc dołożenie pola nie wymaga migracji —
  -- ta sama decyzja co przy `user_view_settings` w 0007.
  parsed            jsonb,
  parse_source      text,
  warnings          text[] not null default '{}',
  error             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Skrzynka pokazuje najnowsze nieprzejrzane, stąd indeks po (status, received_at desc).
create index if not exists email_messages_status_idx on public.email_messages (status, received_at desc);
create index if not exists email_messages_matched_load_idx on public.email_messages (matched_load_id);
-- Wiązanie odpowiedzi w wątku: szukamy maila, którego message_id stoi w References nowego.
create index if not exists email_messages_thread_refs_idx on public.email_messages using gin (thread_refs);

alter table public.email_messages enable row level security;

-- Wzorzec "wymaga logowania" jak w reszcie appki, ale BEZ insertu: maile wstawia wyłącznie
-- `gmail-poll` przez service_role (omija RLS). Dyspozytor ma je czytać i zmieniać im status,
-- nie tworzyć ręcznie — wpis "z ręki" nie miałby Message-ID i psułby dedup.
drop policy if exists "wymaga logowania" on public.email_messages;
create policy "wymaga logowania"
on public.email_messages as permissive for select to authenticated using (true);

drop policy if exists "zalogowany zmienia status" on public.email_messages;
create policy "zalogowany zmienia status"
on public.email_messages as permissive for update to authenticated using (true) with check (true);

drop trigger if exists email_messages_set_updated_at on public.email_messages;
create trigger email_messages_set_updated_at
before update on public.email_messages
for each row execute function public.set_loads_updated_at();

-- ------------------------------------------------------------
-- Załączniki
-- ------------------------------------------------------------
-- Sam plik idzie do prywatnego bucketa Storage (`order-emails`), w bazie zostaje metryka + ścieżka.
-- Trzymanie base64 w kolumnie rozdmuchałoby tabelę i każdy SELECT w Skrzynce.
create table if not exists public.email_attachments (
  id                uuid primary key default gen_random_uuid(),
  email_message_id  uuid not null references public.email_messages (id) on delete cascade,
  filename          text,
  mime_type         text,
  size_bytes        bigint,
  storage_path      text,

  -- Co udało się przeczytać z TEGO konkretnego pliku i czym (znany szablon vs Claude). Trzymane
  -- per załącznik, bo jedno zlecenie to często dwa dokumenty (zlecenie + list przewozowy) i przy
  -- rozjeździe danych trzeba wiedzieć, który plik co wniósł.
  parsed            jsonb,
  parse_source      text,
  error             text,

  created_at        timestamptz not null default now()
);

create index if not exists email_attachments_message_idx on public.email_attachments (email_message_id);

alter table public.email_attachments enable row level security;

drop policy if exists "wymaga logowania" on public.email_attachments;
create policy "wymaga logowania"
on public.email_attachments as permissive for select to authenticated using (true);

-- ------------------------------------------------------------
-- Stan odpytywania skrzynki
-- ------------------------------------------------------------
-- Jeden wiersz (wymuszony `check (id)`). Poller pobiera tylko UID-y większe od `last_uid`, więc
-- nie przegląda skrzynki od zera przy każdym przebiegu.
--
-- `last_error` + `last_ok_at` są tu głównie po to, żeby MARTWY ODCZYT BYŁO WIDAĆ w UI. Hasło
-- aplikacji Google przestaje działać po zmianie hasła głównego konta — bez tego appka po prostu
-- milczałaby i nikt by nie zauważył, że zlecenia przestały przychodzić.
create table if not exists public.email_ingest_state (
  id              boolean primary key default true check (id),
  last_uid        bigint not null default 0,
  uid_validity    bigint,
  last_run_at     timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  seen_total      bigint not null default 0,
  updated_at      timestamptz not null default now()
);

insert into public.email_ingest_state (id) values (true) on conflict (id) do nothing;

alter table public.email_ingest_state enable row level security;

drop policy if exists "wymaga logowania" on public.email_ingest_state;
create policy "wymaga logowania"
on public.email_ingest_state as permissive for select to authenticated using (true);

-- ------------------------------------------------------------
-- Storage na załączniki
-- ------------------------------------------------------------
-- Prywatny bucket: pliki dostępne tylko zalogowanym, przez podpisany URL.
insert into storage.buckets (id, name, public)
values ('order-emails', 'order-emails', false)
on conflict (id) do nothing;

drop policy if exists "zalogowany czyta zalaczniki" on storage.objects;
create policy "zalogowany czyta zalaczniki"
on storage.objects as permissive for select to authenticated
using (bucket_id = 'order-emails');

-- ------------------------------------------------------------
-- Realtime
-- ------------------------------------------------------------
-- Skrzynka ma się zapełniać bez odświeżania strony — tak jak Zestawienie.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'email_messages'
  ) then
    alter publication supabase_realtime add table public.email_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'email_ingest_state'
  ) then
    alter publication supabase_realtime add table public.email_ingest_state;
  end if;
end
$$;

-- ------------------------------------------------------------
-- Dopasowanie maila do istniejącego zlecenia po numerze
-- ------------------------------------------------------------
-- Numer zlecenia jest u klienta unikalny, ale w mailu bywa zapisany inaczej niż w bazie
-- ("ZD/1797/6/2026" vs "ZD 1797/6/2026" vs "zd-1797-6-2026"). Porównujemy więc formy sprowadzone
-- do samych znaków alfanumerycznych, wielkimi literami — tę samą normalizację robi `gmail-poll`
-- na tekście maila, więc obie strony porównania powstają tak samo.
create or replace function public.normalized_order_number(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(value, ''), '[^a-zA-Z0-9]', '', 'g'));
$$;

create index if not exists loads_normalized_order_number_idx
  on public.loads (public.normalized_order_number(order_number));
