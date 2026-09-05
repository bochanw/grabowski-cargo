-- ============================================================
-- 0034 — PIERWSZY PRZEBIEG serwerowego odczytu statusów (rozruch, jednorazowo).
--
-- Po co osobna migracja, zamiast poczekać na crona: harmonogram z 0033 chodzi w oknie „dni
-- robocze 6-18", więc po wdrożeniu w weekend albo wieczorem pierwsza odpowiedź terminala
-- przyszłaby dopiero następnego dnia roboczego. A to WŁAŚNIE pierwszy przebieg rozstrzyga
-- rzecz, której nie da się sprawdzić inaczej: czy BCT i GCT przyjmują zapytania z adresów
-- wyjściowych Supabase (Edge Functions nie mają stałego IP — zmierzone: pięć wywołań, pięć
-- różnych adresów AWS). Dopóki to nie przejdzie, cała droga serwerowa jest hipotezą.
--
-- `loadIds` liczone Z BAZY, nie wpisane na sztywno — i to one sprawiają, że przebieg wykona się
-- mimo weekendu: pytanie o KONKRETNE zlecenia pomija okno godzinowe (tak samo jak kliknięcie
-- dyspozytora „Sprawdź teraz").
--
-- Migracja nic nie zmienia w schemacie. Zapisze natomiast statusy przy tych zleceniach — czyli
-- dokładnie to, co od poniedziałku będzie się działo samo co kwadrans.
-- ============================================================

select net.http_post(
  url := 'https://itlgexjhznjsbonzdxyg.supabase.co/functions/v1/bhub-status',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-ingest-secret', coalesce(
      (select decrypted_secret from vault.decrypted_secrets where name = 'INGEST_SECRET' limit 1),
      ''
    )
  ),
  body := jsonb_build_object(
    'action', 'cykl',
    'loadIds', coalesce(
      (select jsonb_agg(l.id)
         from public.loads l
         join public.terminal_sources t on t.terminal = l.pickup_type and t.mode = 'serwer'
        where l.container_number is not null and btrim(l.container_number) <> ''),
      '[]'::jsonb
    )
  ),
  timeout_milliseconds := 120000
);
