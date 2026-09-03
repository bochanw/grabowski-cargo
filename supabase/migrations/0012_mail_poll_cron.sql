-- ============================================================
-- Harmonogram odpytywania skrzynki — pg_cron woła Edge Function `mail-poll` co 2 minuty.
--
-- Dlaczego pg_cron, a nie webhook z Microsoftu: Graph potrafi wysyłać powiadomienia (subskrypcje),
-- ale wymagają one publicznego endpointu, odnawiania co ~3 dni i obsługi walidacji subskrypcji.
-- Odpytywanie co 2 minuty jest w tej skali bez porównania prostsze, a opóźnienie 2 minut przy
-- zleceniu transportowym nie ma żadnego znaczenia operacyjnego. Gdyby kiedyś miało — subskrypcje
-- da się dołożyć bez ruszania reszty potoku (`mail-poll` i tak jest wywoływane HTTP-em).
--
-- AUTORYZACJA: funkcja ma `verify_jwt = false` (cron nie ma tokenu użytkownika), więc sprawdza
-- sama nagłówek `x-ingest-secret`. Sekret NIE jest wpisany w tej migracji — siedzi w Vault
-- Supabase, a zadanie cron czyta go przy każdym uruchomieniu. Dzięki temu nie ląduje w repozytorium
-- ani w historii migracji, i da się go zmienić bez zmiany kodu.
--
-- ŻEBY TO ZADZIAŁAŁO, właściciel wkleja TEN SAM losowy ciąg w DWÓCH miejscach Dashboardu:
--   1. Project Settings → Vault → New secret, nazwa: INGEST_SECRET
--   2. Project Settings → Edge Functions → Secrets, nazwa: INGEST_SECRET
-- Do czasu ustawienia obu, cron dzwoni i dostaje odmowę (401) — nic się nie psuje, po prostu
-- nic nie przychodzi; „Sprawdź teraz" w UI działa niezależnie, bo tam autoryzuje sesja dyspozytora.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Ponowne uruchomienie migracji nie ma dublować zadania.
select cron.unschedule('mail-poll-co-2-min')
where exists (select 1 from cron.job where jobname = 'mail-poll-co-2-min');

select cron.schedule(
  'mail-poll-co-2-min',
  '*/2 * * * *',
  $cron$
  select net.http_post(
    url := 'https://itlgexjhznjsbonzdxyg.supabase.co/functions/v1/mail-poll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- coalesce, bo dopóki sekretu nie ma w Vault, `decrypted_secret` jest NULL-em, a pg_net
      -- nie przyjmuje nagłówka o wartości null. Pusty ciąg = funkcja odmawia i tyle.
      'x-ingest-secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'INGEST_SECRET' limit 1),
        ''
      )
    ),
    body := '{}'::jsonb,
    -- Jeden przebieg to do 15 maili, z których część idzie do modelu — minuta z zapasem.
    timeout_milliseconds := 60000
  );
  $cron$
);
