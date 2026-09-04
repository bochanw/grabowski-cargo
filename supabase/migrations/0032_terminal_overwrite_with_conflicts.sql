-- ============================================================
-- 0032 — terminal ZNOWU nadpisuje wagi, gestię i wielkość, ale rozbieżność ze zleceniem zostaje
-- widoczna (właściciel: „Wagi, gestie, wielkości nadpisujemy ale musimy alarmować że się nie
-- pokrywają ze zleceniem!").
--
-- 0031 rozwiązała to odwrotnie — nie nadpisywała, żeby było z czym porównywać. To była zła
-- odpowiedź na to samo napięcie: nie da się nadpisać wartości i JEDNOCZEŚNIE pokazać, że się
-- różniła, jeśli nigdzie nie zapamiętamy tego, co stało wcześniej. Więc zapamiętujemy.
--
-- `loads.terminal_conflicts` — mapa „kolumna → wartość, którą miało ZLECENIE, zanim terminal ją
-- nadpisał". Wpis powstaje przy pierwszej realnej rozbieżności i NIE jest przez terminal ruszany
-- (kolejne odpytania widzą już własną wartość terminala, więc bez tej zasady alarm znikałby po
-- kwadransie — dokładnie wtedy, kiedy nikt jeszcze go nie widział). Kasuje go dopiero CZŁOWIEK,
-- poprawiając tę kolumnę w Zestawieniu — to jest świadome „widziałem, tak ma być".
--
-- Kształt: {"gross_weight": "22200", "shipping_line": "MSC", ...}. Zna go wyłącznie appka, baza
-- niczego nie waliduje — kolejna kontrolowana kolumna nie będzie wymagać migracji.
-- ============================================================

alter table public.loads
  add column if not exists terminal_conflicts jsonb not null default '{}'::jsonb;

comment on column public.loads.terminal_conflicts is
  'Co mówiło ZLECENIE, zanim terminal nadpisał daną kolumnę. Klucz = nazwa kolumny. Kasowane przy ręcznej poprawce tej kolumny.';

/**
 * Czy dwie wartości znaczą co innego. Liczby porównujemy jako liczby („22200" = „22200.0"),
 * resztę jako tekst bez wielkości liter i bez spacji („40 HC" = „40HC").
 * NULL albo pusty tekst po którejkolwiek stronie = „nie wiem", czyli NIE różnica.
 */
create or replace function public.rozne_wartosci(a text, b text)
returns boolean
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare
  va text := upper(regexp_replace(coalesce(a, ''), '\s', '', 'g'));
  vb text := upper(regexp_replace(coalesce(b, ''), '\s', '', 'g'));
begin
  if va = '' or vb = '' then return false; end if;
  if va ~ '^[0-9]+([.,][0-9]+)?$' and vb ~ '^[0-9]+([.,][0-9]+)?$' then
    return replace(va, ',', '.')::numeric <> replace(vb, ',', '.')::numeric;
  end if;
  return va <> vb;
end;
$function$;

revoke execute on function public.rozne_wartosci(text, text) from anon, authenticated, public;
grant execute on function public.rozne_wartosci(text, text) to service_role;

drop function if exists public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean, text, numeric, numeric, text);

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
  p_time_out text default null,
  -- Który terminal odpowiedział (BHub / BCT / GCT). Wchodzi do aktora w dzienniku zmian, żeby
  -- z historii dało się odczytać, KTÓRY terminal coś nadpisał.
  p_terminal text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old public.loads%rowtype;
  v_konflikty jsonb;
  v_brutto text;
  v_netto text;
  v_stare_brutto text;
  v_stare_netto text;
begin
  perform set_config('app.actor', 'bot:' || lower(coalesce(nullif(trim(p_terminal), ''), 'baltichub')), true);

  select * into v_old from public.loads where id = p_load_id;
  if not found then return; end if;

  v_konflikty := coalesce(v_old.terminal_conflicts, '{}'::jsonb);

  -- Wartości terminala w tej samej postaci tekstowej, w jakiej trafiają do kolumn zlecenia —
  -- inaczej porównanie „22200" z „22200.00" wychodziłoby jako różnica.
  v_brutto := case when p_gross_weight_kg is null then null
                   else trim(trailing '.' from trim(to_char(p_gross_weight_kg, 'FM9999999990.99'))) end;
  v_netto := case when p_net_weight_kg is null then null else p_net_weight_kg::text end;
  v_stare_brutto := case when v_old.bhub_gross_weight_kg is null then null
                         else trim(trailing '.' from trim(to_char(v_old.bhub_gross_weight_kg, 'FM9999999990.99'))) end;
  v_stare_netto := case when v_old.bhub_net_weight_kg is null then null else v_old.bhub_net_weight_kg::text end;

  -- Zapis konfliktu, ta sama reguła dla każdej kolumny:
  --   1. wpisu jeszcze nie ma          — trzyma to, co powiedziało ZLECENIE, i nie nadpisujemy go,
  --   2. wartość w zleceniu != wartość terminala,
  --   3. wartość w zleceniu nie jest tym, co sam terminal wpisał POPRZEDNIM razem — inaczej przy
  --      zmianie wagi (VGM bywa poprawiane) zapamiętalibyśmy własną, starą liczbę jako „zlecenie".
  -- Przy wielkości warunek 3 pomijamy: terminal podaje ją jako kod ISO, którego SQL nie umie
  -- przeliczyć na zapis klienta, a typ kontenera między odpytaniami się nie zmienia (w odróżnieniu
  -- od wagi). Warunek 1 i tak pilnuje, żeby wpis powstał najwyżej raz.
  if p_parsed then
    if not (v_konflikty ? 'gross_weight')
       and public.rozne_wartosci(v_old.gross_weight, v_brutto)
       and (v_stare_brutto is null or public.rozne_wartosci(v_old.gross_weight, v_stare_brutto)) then
      v_konflikty := v_konflikty || jsonb_build_object('gross_weight', v_old.gross_weight);
    end if;

    if not (v_konflikty ? 'net_weight_kg')
       and public.rozne_wartosci(v_old.net_weight_kg::text, v_netto)
       and (v_stare_netto is null or public.rozne_wartosci(v_old.net_weight_kg::text, v_stare_netto)) then
      v_konflikty := v_konflikty || jsonb_build_object('net_weight_kg', v_old.net_weight_kg::text);
    end if;

    if not (v_konflikty ? 'container_size')
       and public.rozne_wartosci(v_old.container_size, p_container_size) then
      v_konflikty := v_konflikty || jsonb_build_object('container_size', v_old.container_size);
    end if;

    if not (v_konflikty ? 'shipping_line')
       and public.rozne_wartosci(v_old.shipping_line, p_shipping_line)
       and (v_old.bhub_shipping_line is null or public.rozne_wartosci(v_old.shipping_line, v_old.bhub_shipping_line)) then
      v_konflikty := v_konflikty || jsonb_build_object('shipping_line', v_old.shipping_line);
    end if;
  end if;

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
    terminal_conflicts       = v_konflikty,
    -- NADPISUJEMY (właściciel wprost). Ręczny tekst w „Wadze brutto" („według armatora") też
    -- ustępuje liczbie z terminala — ale ląduje w `terminal_conflicts`, więc widać, co tam było.
    gross_weight   = case when p_parsed and v_brutto is not null then v_brutto else gross_weight end,
    net_weight_kg  = case when p_parsed and p_net_weight_kg is not null then p_net_weight_kg else net_weight_kg end,
    container_size = case when p_parsed and p_container_size is not null then p_container_size else container_size end,
    shipping_line  = case when p_parsed and p_shipping_line is not null then p_shipping_line else shipping_line end
  where id = p_load_id;
end;
$function$;

revoke execute on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean, text, numeric, numeric, text, text)
  from anon, authenticated, public;
grant execute on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean, text, numeric, numeric, text, text)
  to service_role;
