-- ============================================================
-- 0021 — terminal uzupełnia też „Gestię" (armatora), gdy jest pusta.
--
-- Właściciel po pierwszym udanym odczycie: „nie pobrałeś gestii, nie pogrubiłeś pewnych danych".
-- Jedno wynika z drugiego: pogrubienie w Zestawieniu znaczy „terminal potwierdza to, co mamy
-- w zleceniu" (`bhubCellDecoration`), więc przy PUSTEJ Gestii i Wielkości nie było czego
-- potwierdzać — reguła zwracała „nie wiem" i komórka zostawała zwykła.
--
-- Ta sama zasada co przy wielkości (0020): wpisujemy WYŁĄCZNIE w puste pole.
--   - wartość z dokumentu albo wpisana przez dyspozytora zostaje nietknięta,
--   - „Leasing" (nasza własna wartość z reguły o uwagach) też zostaje — nie jest pusty,
--   - przy rozbieżności appka alarmuje w kolumnie Gestia (⚠), zamiast po cichu podmieniać.
--
-- Terminal podaje TRZYLITEROWY kod armatora (CMA, OOL, MSC) — tak samo zapisuje go arkusz klienta.
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
    container_size       = case when p_parsed and p_container_size is not null
                                then coalesce(nullif(trim(container_size), ''), p_container_size)
                                else container_size end,
    -- Gestia: wyłącznie w puste pole, dokładnie jak wielkość.
    shipping_line        = case when p_parsed and p_shipping_line is not null
                                then coalesce(nullif(trim(shipping_line), ''), p_shipping_line)
                                else shipping_line end
  where id = p_load_id;
end;
$function$;
