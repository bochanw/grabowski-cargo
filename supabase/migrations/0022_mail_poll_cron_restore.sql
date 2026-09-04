-- ============================================================
-- Przywrócenie harmonogramu `mail-poll` po incydencie kosztowym z Claude Console.
--
-- CO SIĘ STAŁO: poller wołał płatny odczyt (`parse-order-pdf`) dla każdego maila PRZED
-- sprawdzeniem, czy ten mail już jest w bazie. Kursor Microsoft Graph celowo porównuje `ge`
-- ("lepiej powtórzyć wiadomość niż ją zgubić" — patrz graph.ts), więc te same wiadomości wracały
-- w każdym przebiegu co 2 minuty i były odczytywane od nowa: 515 wywołań przez jedną noc,
-- do wyczerpania środków właściciela. Harmonogram został wtedy WYŁĄCZONY ręcznie
-- (`select cron.unschedule('mail-poll-co-2-min')`), żeby zatrzymać wydatek natychmiast.
--
-- CO ZOSTAŁO NAPRAWIONE, ZANIM WRÓCIŁ (bez tego ta migracja NIE MA sensu):
--   1. `mail-poll` sprawdza duplikaty JEDNYM zapytaniem przed jakąkolwiek pracą nad mailem
--      i w ogóle nie woła modelu — robi wyłącznie rzeczy darmowe (prefiltr, znane szablony).
--   2. Płatny odczyt rusza z guzika „Odczytaj przez Claude" w Skrzynce, przy konkretnym mailu,
--      który ktoś ogląda (src/lib/supabase/readEmailWithClaude.ts).
--   3. `parse-order-pdf` odrzuca (403) wywołania spoza sesji zalogowanego człowieka — poprawka
--      w jednym wywołującym nie chroniłaby przed następnym takim automatem.
--
-- Sam harmonogram jest DOKŁADNIE taki jak w 0012 (co 2 minuty, sekret z Vault) — ta migracja
-- niczego w nim nie zmienia, tylko zapisuje w historii, że był wyłączony i dlaczego wrócił.
-- ============================================================

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
      'x-ingest-secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'INGEST_SECRET' limit 1),
        ''
      )
    ),
    body := '{}'::jsonb,
    -- Przebieg jest teraz krótszy niż przy pisaniu 0012 (nie ma czekania na model), ale minuta
    -- z zapasem zostaje: pobranie kilkunastu maili z załącznikami bywa wolne.
    timeout_milliseconds := 60000
  );
  $cron$
);
