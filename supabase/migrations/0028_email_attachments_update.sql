-- Zalogowany dyspozytor może zapisać ODCZYT przy pojedynczym załączniku maila.
--
-- Po co: jeden mail bywa KILKOMA zleceniami (właściciel: „czasami jest ich kilka (kilka zleceń)"),
-- a rozdzielić je da się tylko wtedy, gdy wiadomo, co odczytano z KTÓREGO dokumentu — stąd
-- `email_attachments.parsed`. Poller pisze to kluczem service_role (RLS go nie dotyczy), ale
-- płatny odczyt „Odczytaj przez Claude" rusza z przeglądarki i pisał w pustkę: tabela miała
-- politykę tylko na SELECT, więc UPDATE nie wywalał się błędem — po prostu nie zmieniał nic
-- (RLS odfiltrowuje wiersze, PostgREST zwraca sukces z zerem zmienionych wierszy).
--
-- Zakres jak w całej appce: „wymaga logowania" — każdy zalogowany dyspozytor, bo Skrzynka jest
-- wspólna. Bez INSERT i DELETE: wiersze załączników tworzy wyłącznie poller, a kasowanie maila
-- nie jest operacją, której dyspozytor tu potrzebuje.

drop policy if exists "zalogowany zapisuje odczyt" on public.email_attachments;

create policy "zalogowany zapisuje odczyt"
  on public.email_attachments
  for update
  to authenticated
  using (true)
  with check (true);
