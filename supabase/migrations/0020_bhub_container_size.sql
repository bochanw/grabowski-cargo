-- ============================================================
-- 0020 — terminal uzupełnia „Wielkość" zlecenia, gdy jest pusta.
--
-- Właściciel wprost: „mogłeś też pobrać ISO Type 22G1 i zamienić go na 20 (to jest ich
-- oznaczenie)". Terminal podaje normę ISO 6346, arkusz klienta swój skrót (20 DV, 40 HC, 45) —
-- zamiana siedzi w `src/lib/bhub/isoType.ts` (jedno źródło; kopia dla Deno jedzie przez
-- scripts/build-edge-shared.mjs), a funkcja brzegowa podaje tu gotową wartość.
--
-- TYLKO GDY PUSTE. Waga brutto z terminala jest nadrzędna i nadpisuje zlecenie (tak ustalił
-- właściciel), ale o wielkości tego nie powiedział — a wpisana ręcznie przez dyspozytora albo
-- wzięta z dokumentu bywa dokładniejsza niż to, co terminal zdążył zaksięgować. Przy rozbieżności
-- appka i tak ALARMUJE w kolumnie statusu (`compareIsoLength` → ⚠), więc cicha podmiana byłaby
-- gorsza niż zostawienie sprzeczności na wierzchu.
--
-- Reszta ciała funkcji bez zmian — przepisana w całości, bo `create or replace` wymaga kompletu.
-- ============================================================

create or replace function public.apply_bhub_check(
  p_load_id uuid,
  p_status text default null,
  p_status_raw text default null,
  p_iso_type text default null,
  p_shipping_line text default null,
  p_gross_weight_kg numeric default null,
  p_error text default null,
  p_details jsonb default null,
  p_parsed boolean default false,
  p_container_size text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform set_config('app.actor', 'bot:baltichub', true);

  update public.loads set
    bhub_status          = case when p_parsed then p_status          else bhub_status end,
    bhub_status_raw      = case when p_parsed then p_status_raw      else bhub_status_raw end,
    bhub_iso_type        = case when p_parsed then p_iso_type        else bhub_iso_type end,
    bhub_shipping_line   = case when p_parsed then p_shipping_line   else bhub_shipping_line end,
    bhub_gross_weight_kg = case when p_parsed then p_gross_weight_kg else bhub_gross_weight_kg end,
    bhub_checked_at      = now(),
    bhub_error           = p_error,
    bhub_details         = coalesce(p_details, bhub_details),
    gross_weight         = case when p_parsed and p_gross_weight_kg is not null
                                then trim(trailing '.' from trim(to_char(p_gross_weight_kg, 'FM9999999990.99')))
                                else gross_weight end,
    -- Wielkość: wyłącznie w puste pole. `nullif(trim(...), '')` po to, żeby spacja z arkusza
    -- też liczyła się jako brak.
    container_size       = case when p_parsed and p_container_size is not null
                                then coalesce(nullif(trim(container_size), ''), p_container_size)
                                else container_size end
  where id = p_load_id;
end;
$function$;
