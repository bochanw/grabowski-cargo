-- ============================================================
-- Status kontenera z Baltic Hub (https://baltichub.com/dla-klienta/sprawdz-kontener).
--
-- Właściciel: "Dla kontenerów które podejmiemy z BHub sprawdzamy ich status. W tabeli będziemy to
-- oznaczać jako SS/ZS/SO/SP/ZP + kolor. Sprawdzając kontener po raz pierwszy pobierzemy wagę
-- brutto kontenera (ta jest nadrzędna i nadpisuje dowolne wartości ze zleceń). Sprawdź ISOtype
-- (długość) i porównaj czy się pokrywa z tą ze zlecenia. Sprawdź także czy Gestia się zgadza."
--
-- Kolumny są SUROWYM ZAPISEM tego, co powiedział terminal — porównania (ISO ↔ wielkość, armator ↔
-- gestia) liczy appka przy wyświetlaniu, a nie baza. Dzięki temu poprawka reguły porównania nie
-- wymaga migracji ani ponownego odpytania terminala.
-- ============================================================

alter table public.loads
  -- Kod z pięciu ustalonych przez właściciela. NULL = jeszcze nie sprawdzaliśmy albo terminal
  -- podał coś, czego nie umiemy nazwać (wtedy treść siedzi w bhub_status_raw).
  add column if not exists bhub_status text,
  -- Dokładnie to, co napisał terminal. Właściciel zapowiedział, że znaczenie kolejnych statusów
  -- będzie tłumaczył z czasem — bez surowego zapisu nie dałoby się wstecznie domapować tego, co
  -- już przeszło przez appkę, bo nierozpoznanego statusu nie ma jak odtworzyć.
  add column if not exists bhub_status_raw text,
  add column if not exists bhub_iso_type text,
  add column if not exists bhub_shipping_line text,
  -- Waga brutto z terminala. NADRZĘDNA nad wszystkim ze zlecenia (reguła właściciela), a przy
  -- okazji wyłącza wyliczanie brutto z wagi towaru + tary — patrz src/lib/containers/tare.ts.
  add column if not exists bhub_gross_weight_kg numeric,
  add column if not exists bhub_checked_at timestamptz,
  -- Treść błędu ostatniego sprawdzenia (np. blokada Cloudflare, brak kontenera w systemie).
  -- Widoczna w appce: martwy odczyt musi być widać, a nie cicho przestać działać.
  add column if not exists bhub_error text,
  -- Pełna migawka odpowiedzi terminala — do domapowania kolejnych statusów bez odpytywania od nowa.
  add column if not exists bhub_details jsonb;

alter table public.loads drop constraint if exists loads_bhub_status_check;
alter table public.loads
  add constraint loads_bhub_status_check
  check (bhub_status is null or bhub_status in ('SS', 'ZS', 'SO', 'SP', 'ZP'));

-- Pętla odpytywania szuka dokładnie tego zbioru: podjęcie z BHub, znany kontener, status inny niż
-- ZP ("ZP już nie ruszamy"). Indeks częściowy, bo to zawsze mały wycinek tabeli.
create index if not exists loads_bhub_pending_idx
  on public.loads (bhub_checked_at nulls first)
  where pickup_type = 'BHub'
    and container_number is not null
    and (bhub_status is null or bhub_status <> 'ZP');

-- ------------------------------------------------------------
-- Zapis wyniku sprawdzenia — przez funkcję, nie zwykłym UPDATE z Edge Function.
--
-- Dwa powody, oba konkretne:
-- 1. AKTOR W DZIENNIKU. `app.actor` musi być ustawiony w TEJ SAMEJ transakcji co UPDATE, a każde
--    wywołanie PostgREST to osobna transakcja — z poziomu klienta nie da się tego złożyć. Bez tego
--    zmiany statusu podpisywałyby się jako 'bot:service_role' zamiast 'bot:baltichub'.
-- 2. WAGA. Reguła "waga z terminala jest nadrzędna i nadpisuje dowolne wartości ze zleceń" siedzi
--    tu raz, zamiast być powtarzana w każdym miejscu, które dotyka wagi.
--
-- Parametry są wypisane wprost (zamiast dowolnego jsonb), żeby ta ścieżka mogła zmieniać WYŁĄCZNIE
-- pola statusu i wagę — funkcja jest security definer, więc nie może być furtką do reszty rekordu.
-- ------------------------------------------------------------
create or replace function public.apply_bhub_check(
  p_load_id          uuid,
  p_status           text default null,
  p_status_raw       text default null,
  p_iso_type         text default null,
  p_shipping_line    text default null,
  p_gross_weight_kg  numeric default null,
  p_error            text default null,
  p_details          jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('app.actor', 'bot:baltichub', true);

  update public.loads set
    bhub_status          = p_status,
    bhub_status_raw      = p_status_raw,
    bhub_iso_type        = coalesce(p_iso_type, bhub_iso_type),
    bhub_shipping_line   = coalesce(p_shipping_line, bhub_shipping_line),
    bhub_gross_weight_kg = coalesce(p_gross_weight_kg, bhub_gross_weight_kg),
    bhub_checked_at      = now(),
    bhub_error           = p_error,
    bhub_details         = coalesce(p_details, bhub_details),
    -- Waga brutto z terminala nadpisuje to, co przyszło ze zlecenia (reguła właściciela). Zapisujemy
    -- ją też do kolumny "Waga brutto", bo to ona jest w Zestawieniu i to na nią patrzy dyspozytor.
    --
    -- `trim(trailing '.')` nie jest ozdobnikiem: FM…0.99 dla liczby całkowitej zwraca "24000."
    -- z kropką na końcu (sprawdzone na bazie). Taki zapis nie tylko brzydko wygląda w tabeli, ale
    -- przestaje pasować do wzorca "czysto liczbowej wagi" w canOverwriteGrossWeight, więc appka
    -- uznałaby go za ręczny tekst w rodzaju "według armatora".
    gross_weight         = case when p_gross_weight_kg is not null
                                then trim(trailing '.' from trim(to_char(p_gross_weight_kg, 'FM9999999990.99')))
                                else gross_weight end
  where id = p_load_id;
end;
$$;

revoke all on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb) from public, anon;
grant execute on function public.apply_bhub_check(uuid, text, text, text, text, numeric, text, jsonb) to authenticated, service_role;

-- ------------------------------------------------------------
-- Dziennik zmian: pomijamy księgowość odpytywania.
--
-- Bez tego KAŻDE sprawdzenie (co 15 minut, 6-18, per kontener) dopisywałoby wpis do activity_log,
-- bo bhub_checked_at zmienia się zawsze — kilkaset wpisów dziennie utopiłyby prawdziwą historię
-- zmian. Pomijane są tylko pola techniczne; zmiana STATUSU, wagi czy armatora nadal się loguje
-- (z aktorem 'bot:baltichub'), bo to jest właśnie to, co dyspozytor chce w historii zobaczyć.
--
-- Reszta funkcji jest bez zmian względem 0003.
-- ------------------------------------------------------------
create or replace function public.log_loads_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    text := coalesce(
    nullif(current_setting('app.actor', true), ''),
    auth.jwt() ->> 'email',
    'bot:' || coalesce(auth.role(), 'unknown')
  );
  v_actor_id uuid := auth.uid();
  v_old      jsonb;
  v_new      jsonb;
  v_before   jsonb := '{}'::jsonb;
  v_after    jsonb := '{}'::jsonb;
  v_key      text;
begin
  if tg_op = 'INSERT' then
    insert into public.activity_log (load_id, order_number, action, before, after, actor, actor_id)
    values (new.id, new.order_number, 'insert', null, to_jsonb(new) - 'created_at' - 'updated_at', v_actor, v_actor_id);
    return null;
  end if;

  if tg_op = 'DELETE' then
    insert into public.activity_log (load_id, order_number, action, before, after, actor, actor_id)
    values (old.id, old.order_number, 'delete', to_jsonb(old) - 'created_at' - 'updated_at', null, v_actor, v_actor_id);
    return null;
  end if;

  -- UPDATE: tylko pola, które faktycznie się zmieniły (updated_at zmienia się zawsze — pomijamy;
  -- bhub_checked_at i bhub_details zmieniają się przy każdym odpytaniu terminala — też pomijamy).
  v_old := to_jsonb(old) - 'updated_at' - 'bhub_checked_at' - 'bhub_details';
  v_new := to_jsonb(new) - 'updated_at' - 'bhub_checked_at' - 'bhub_details';
  for v_key in select key from jsonb_each(v_new) loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after  := v_after  || jsonb_build_object(v_key, v_new -> v_key);
    end if;
  end loop;
  if v_after = '{}'::jsonb then
    return null; -- UPDATE bez realnej zmiany (np. Enter na tej samej wartości) — nie zaśmiecamy dziennika
  end if;

  insert into public.activity_log (load_id, order_number, action, before, after, actor, actor_id)
  values (new.id, new.order_number, 'update', v_before, v_after, v_actor, v_actor_id);
  return null;
end;
$$;
