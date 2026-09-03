-- ============================================================
-- `apply_bhub_check` nadpisuje pola TYLKO przy udanym odczycie.
--
-- Powód jest z produkcji, nie z teorii. Pierwsza wersja zapisywała pola przez `coalesce(nowa,
-- stara)`, żeby nieudany odczyt nie kasował dobrych danych. Skutek uboczny okazał się gorszy niż
-- problem: wartość raz wpisana błędnie NIE DAŁA SIĘ JUŻ USUNĄĆ. Po błędzie w rozpoznawaniu kodu
-- ISO przy zleceniach zostały "LINK" i "LEFT" jako typ kontenera i wisiały tam przez kolejne
-- przebiegi, bo każdy następny odczyt zwracał null, a `coalesce` przywracał śmieć.
--
-- Teraz decyduje jawny `p_parsed`:
--   true  — odpowiedź terminala została odczytana; wpisujemy dokładnie to, co z niej wyszło
--           (także NULL-e, bo "terminal tego nie podaje" to prawdziwa informacja),
--   false — odczyt się nie udał; ruszamy WYŁĄCZNIE czas sprawdzenia, treść błędu i migawkę,
--           a dotychczasowe wartości zostają nietknięte.
--
-- Migracja czyści też typy ISO, które nie są kodem ISO 6346 — to sprzątanie po tamtym błędzie.
-- ============================================================

create or replace function public.apply_bhub_check(
  p_load_id          uuid,
  p_status           text default null,
  p_status_raw       text default null,
  p_iso_type         text default null,
  p_shipping_line    text default null,
  p_gross_weight_kg  numeric default null,
  p_error            text default null,
  p_details          jsonb default null,
  p_parsed           boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    -- Waga brutto z terminala nadpisuje wartość ze zlecenia (reguła właściciela), ale tylko wtedy,
    -- gdy odczyt się powiódł i waga faktycznie przyszła.
    --
    -- `trim(trailing '.')` nie jest ozdobnikiem: FM…0.99 dla liczby całkowitej zwraca "24000."
    -- z kropką na końcu (sprawdzone na bazie). Taki zapis przestaje pasować do wzorca "czysto
    -- liczbowej wagi" w canOverwriteGrossWeight, więc appka uznałaby go za ręczny tekst.
    gross_weight         = case when p_parsed and p_gross_weight_kg is not null
                                then trim(trailing '.' from trim(to_char(p_gross_weight_kg, 'FM9999999990.99')))
                                else gross_weight end
  where id = p_load_id;
end;
$$;

revoke all on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean) from public, anon;
grant execute on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb, boolean) to authenticated, service_role;

-- Stara sygnatura (bez p_parsed) zostawiona jako martwy przeciążony wariant myliłaby PostgREST przy
-- wywołaniu z pominięciem argumentów domyślnych — usuwamy ją wprost.
drop function if exists public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb);

-- Sprzątanie po błędzie w rozpoznawaniu kodu ISO: zostawiamy tylko wartości, które NAPRAWDĘ są
-- kodem ISO 6346 (długość / wysokość / rodzina / wariant). "LINK" i "LEFT" odpadają.
do $$
declare v_ile int;
begin
  perform set_config('app.actor', 'bot:baltichub-korekta', true);
  update public.loads
     set bhub_iso_type = null
   where bhub_iso_type is not null
     and bhub_iso_type !~ '^[24L][0-9CDEF][ABGHKNPRSTUV][0-9A-Z]$';
  get diagnostics v_ile = row_count;
  raise notice 'Wyczyszczono blednych typow ISO: %', v_ile;
end $$;
