-- ============================================================
-- Konfiguracja widoku Zestawienia PER UŻYTKOWNIK (właściciel: "dałbym użytkownikom możliwość
-- ręcznego ustalania co chcą widzieć bez narzucania. Wybór pól i kolejność daj. Wystarczy
-- zamrozić pierwsze N kolumn").
--
-- Świadomie w Supabase, nie w localStorage: dyspozytor siadający przy innym stanowisku ma
-- dostać swój widok. Jeden wiersz per użytkownik, konfiguracja jako jsonb — kształt zna
-- WYŁĄCZNIE aplikacja (src/lib/view/viewSettings.ts), baza go nie waliduje, więc dołożenie
-- kolejnej opcji widoku nie wymaga migracji. Każdy odczyt przechodzi przez
-- `normalizeViewSettings()` po stronie appki, bo jsonb może zawierać cokolwiek (stara wersja
-- appki, ręczna edycja).
--
-- Kształt (stan na 0007):
--   { "order": ["load_date", "pickup_type", ...],   -- klucze kolumn w kolejności użytkownika
--     "hidden": ["baf_amount", ...],                -- które z nich są ukryte
--     "frozen": 2 }                                 -- ile pierwszych WIDOCZNYCH kolumn przyklejonych
--                                                   -- do lewej krawędzi przy przewijaniu
-- `order` pełni też rolę "kolumny znane w chwili zapisu": kolumna dodana później w kodzie
-- (nieobecna w `order`) trafia na koniec listy i jest widoczna tylko, gdy należy do bloku
-- podstawowego — inaczej nowe pole samo wskakiwałoby ludziom do widoku.
-- ============================================================

create table if not exists public.user_view_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_view_settings enable row level security;

-- Inaczej niż pozostałe tabele tej appki ("wymaga logowania" = każdy zalogowany widzi wszystko):
-- to są USTAWIENIA PRYWATNE. Zalogowany widzi i zmienia WYŁĄCZNIE swój wiersz — `auth.uid()`
-- zarówno w using (odczyt/update/delete), jak i w with check (insert/update), żeby nie dało się
-- zapisać wiersza pod cudzym user_id.
drop policy if exists "tylko wlasne ustawienia" on public.user_view_settings;
create policy "tylko wlasne ustawienia"
on public.user_view_settings as permissive for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Funkcja z 0001 jest generyczna (ustawia new.updated_at).
drop trigger if exists user_view_settings_set_updated_at on public.user_view_settings;
create trigger user_view_settings_set_updated_at
before update on public.user_view_settings
for each row execute function public.set_loads_updated_at();

-- Świadomie BEZ Realtime i BEZ activity_log: to ustawienia jednej osoby, nie dane wspólne.
-- Zmiana widoku ma być widoczna natychmiast w karcie, w której jej dokonano (cache TanStack
-- Query aktualizowany optymistycznie); druga karta tej samej osoby dociągnie ją przy odświeżeniu.
