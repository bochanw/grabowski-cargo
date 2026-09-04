-- ============================================================
-- 0031 — trzy nowe rubryki karty kontenera z Baltic Hub (zgłoszenie właściciela):
--
--   1. „Time Out"              — musi być PUSTY; niepusty = kontener opuścił terminal → ostrzeżenie
--                                przy numerze kontenera,
--   2. „Commodity Weight [KG]" — powinna równać się „Cargo Weight [KG]"; różnica = ostrzeżenie
--                                (waga zgłoszona do Urzędu Celnego rozjeżdża się z wagą towaru),
--   3. „Cargo Weight [KG]"     — waga samego towaru, czyli nasza „Waga netto". Brutto (`Weight [KG]`,
--                                czyli VGM) czytaliśmy już wcześniej.
--
-- ZMIANA ZASADY PRZY WADZE BRUTTO, świadoma i wymuszona przez to zgłoszenie. Do tej pory RPC
-- NADPISYWAŁO `loads.gross_weight` wagą z terminala („waga z terminala jest nadrzędna", 0016).
-- Właściciel prosi teraz, żeby przy RÓŻNICY ze zleceniem stawał trójkącik — a różnicy nie da się
-- pokazać, jeśli sekundę wcześniej sami skasowaliśmy to, z czym mielibyśmy porównywać. Terminal
-- wpisuje więc wagi WYŁĄCZNIE W PUSTE POLA (dokładnie jak wielkość w 0020 i gestia w 0021), a jego
-- własne wartości siedzą w kolumnach `bhub_*` i to je widać w Zestawieniu: pogrubione, gdy zgodne,
-- z ⚠ i obiema liczbami w dymku, gdy nie. „Nadrzędność" nie znika: wszystko, co LICZY na wadze
-- (stawka kierowcy, kafelek Planu), bierze najpierw `bhub_gross_weight_kg`.
--
-- Przy okazji naprawione: `to_char(...)` nadpisywało też ręczny tekst („według armatora"), którego
-- appka w swojej regule `canOverwriteGrossWeight` świadomie NIE rusza. Teraz obie strony mówią
-- to samo.
-- ============================================================

alter table public.loads
  add column if not exists bhub_time_out text,
  add column if not exists bhub_net_weight_kg numeric,
  add column if not exists bhub_commodity_weight_kg numeric;

comment on column public.loads.bhub_time_out is
  'Time Out z karty Baltic Hub. PUSTY TEKST = rubryka jest i jest pusta (kontener stoi); NULL = nie odczytano.';
comment on column public.loads.bhub_net_weight_kg is 'Cargo Weight [KG] z Baltic Hub — waga samego towaru (VGM minus tara).';
comment on column public.loads.bhub_commodity_weight_kg is 'Commodity Weight [KG] z Baltic Hub — waga zgłoszona do Urzędu Celnego.';

-- DWA `drop`, nie jeden. Dodanie parametru do funkcji NIE zastępuje jej, tylko tworzy
-- PRZECIĄŻENIE — i tak od 0020 stała na produkcji także stara, 9-argumentowa wersja (sprzed
-- `p_container_size`). Wywołania bez tego parametru (ścieżki błędu) pasowały do obu, czyli o tym,
-- co się wykona, decydowało rozstrzyganie przeciążeń Postgresa, a nie nasza migracja.
-- Sprawdzone zapytaniem do `pg_proc` PO zaaplikowaniu: zostaje dokładnie jedna wersja.
drop function if exists public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean);
drop function if exists public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean, text);

create function public.apply_bhub_check(
  p_load_id uuid,
  p_status text default null,
  p_status_raw text default null,
  p_iso_type text default null,
  p_shipping_line text default null,
  p_gross_weight_kg numeric default null,
  p_error text default null,
  p_details jsonb default null,
  p_parsed boolean default false,
  p_container_size text default null,
  p_net_weight_kg numeric default null,
  p_commodity_weight_kg numeric default null,
  p_time_out text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform set_config('app.actor', 'bot:baltichub', true);

  update public.loads set
    bhub_status              = case when p_parsed then p_status              else bhub_status end,
    bhub_status_raw          = case when p_parsed then p_status_raw          else bhub_status_raw end,
    bhub_iso_type            = case when p_parsed then p_iso_type            else bhub_iso_type end,
    bhub_shipping_line       = case when p_parsed then p_shipping_line       else bhub_shipping_line end,
    bhub_gross_weight_kg     = case when p_parsed then p_gross_weight_kg     else bhub_gross_weight_kg end,
    bhub_net_weight_kg       = case when p_parsed then p_net_weight_kg       else bhub_net_weight_kg end,
    bhub_commodity_weight_kg = case when p_parsed then p_commodity_weight_kg else bhub_commodity_weight_kg end,
    bhub_time_out            = case when p_parsed then p_time_out            else bhub_time_out end,
    bhub_checked_at          = now(),
    bhub_error               = p_error,
    bhub_details             = coalesce(p_details, bhub_details),
    -- Wagi, wielkość i gestia: WYŁĄCZNIE w puste pole. Zlecenie zostaje źródłem prawdy o tym, co
    -- napisał spedytor; rozbieżność pokazuje Zestawienie, zamiast kasować ją po cichu.
    gross_weight       = case when p_parsed and p_gross_weight_kg is not null
                              then coalesce(nullif(trim(gross_weight), ''),
                                            trim(trailing '.' from trim(to_char(p_gross_weight_kg, 'FM9999999990.99'))))
                              else gross_weight end,
    net_weight_kg      = case when p_parsed and p_net_weight_kg is not null
                              then coalesce(net_weight_kg, p_net_weight_kg)
                              else net_weight_kg end,
    container_size     = case when p_parsed and p_container_size is not null
                              then coalesce(nullif(trim(container_size), ''), p_container_size)
                              else container_size end,
    shipping_line      = case when p_parsed and p_shipping_line is not null
                              then coalesce(nullif(trim(shipping_line), ''), p_shipping_line)
                              else shipping_line end
  where id = p_load_id;
end;
$function$;

-- Ta sama ostrożność co w 0006/0025: EXECUTE na funkcji Postgres nadaje roli PUBLIC z automatu,
-- więc samo `revoke ... from anon, authenticated` NIC by nie odebrało. Funkcję woła wyłącznie
-- `service_role` z funkcji brzegowej — z przeglądarki nie ma po co być dostępna.
revoke execute on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean, text, numeric, numeric, text)
  from anon, authenticated, public;

-- ...a po odebraniu PUBLIC trzeba nadać JAWNIE roli, która tę funkcję faktycznie woła. Bez tej
-- linijki „sprzątanie uprawnień" odcięłoby zapis statusów — dokładnie ta klasa błędu, która przy
-- 0008 przeszła „z sukcesem", nie robiąc tego, co miała.
grant execute on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean, text, numeric, numeric, text)
  to service_role;
