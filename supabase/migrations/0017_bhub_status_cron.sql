-- ============================================================
-- Harmonogram sprawdzania statusów w Baltic Hub — pg_cron woła Edge Function `bhub-status`.
--
-- Właściciel: "Odpytujemy co 15 minut w dni robocze od 6 do 18."
--
-- Cron chodzi w UTC, a okno "6-18" jest w czasie WARSZAWSKIM, więc harmonogram celowo obejmuje
-- godziny 4-17 UTC (najszersze okno, jakie pokrywa 6-18 czasu polskiego zimą i latem), a
-- ROZSTRZYGA funkcja: `isWithinPollingWindow` liczy godzinę w strefie Europe/Warsaw i odrzuca
-- przebieg poza oknem, zwracając `skipped`. Jedna reguła w jednym miejscu, wspólna z appką
-- (shared/schedule.ts) — cron nie musi wiedzieć o zmianie czasu ani o polskich świętach.
--
-- Dni robocze też sprawdza funkcja (ta sama lista świąt co przy liczeniu domyślnej daty zlecenia),
-- dlatego w harmonogramie stoi pon-pt bez wyjątków — święta odsiewa kod, nie cron.
--
-- ============================ KIEDY TO WŁĄCZYĆ ============================
-- NIE APLIKOWAĆ, dopóki funkcja nie ma działającego transportu (patrz supabase/functions/
-- bhub-status/source.ts): baltichub.com jest za Cloudflare i odrzuca zapytania z serwerowni, więc
-- cron dzwoniłby co 15 minut tylko po to, żeby wpisać przy każdym zleceniu ten sam błąd.
-- Kolejność: najpierw BHUB_SOURCE=proxy + klucz usługi w sekretach, ręczne sprawdzenie guzikiem
-- „Statusy BHub" w appce, dopiero potem ta migracja.
-- ==========================================================================
--
-- AUTORYZACJA: jak w 0012 — sekret `INGEST_SECRET` z Vault, ten sam co dla `mail-poll`.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('bhub-status-co-15-min')
where exists (select 1 from cron.job where jobname = 'bhub-status-co-15-min');

select cron.schedule(
  'bhub-status-co-15-min',
  -- co 15 minut, pon-pt, 4:00-17:59 UTC (patrz komentarz wyżej — dokładne okno odcina funkcja)
  '*/15 4-17 * * 1-5',
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
    body := '{}'::jsonb,
    -- Do 25 kontenerów na przebieg, każdy to jedno pobranie strony przez usługę pośredniczącą.
    timeout_milliseconds := 120000
  );
  $cron$
);
