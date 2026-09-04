-- ============================================================
-- ODCZYT TYLKO OZNACZONYCH MAILI (kolorowa kategoria / flaga w Outlooku)
--
-- Właściciel: "pracownik klienta oznacza zlecenie czerwonym kolorkiem (taki prostokąt przy widoku
-- załącznika) oznaczając że jest to zlecenie do wpisania — czy program mógłby tylko odczytywać tak
-- oflagowane zlecenia".
--
-- Czerwony PROSTOKĄT w Outlooku to kolorowa KATEGORIA (Graph: `categories`, tablica nazw nadanych
-- przez użytkownika), a nie flaga do wykonania (Graph: `flag.flagStatus`, rysowana jako chorągiewka).
-- Appka zapisuje OBA sygnały, bo nazwa kategorii jest dowolna i zależy od ustawień skrzynki — nikt
-- z nas jej nie zna z góry. Dzięki temu po pierwszym przebiegu widać w Skrzynce, czym te maile są
-- naprawdę oznaczone, i można zawęzić regułę do konkretnej kategorii jednym kliknięciem, zamiast
-- zgadywać nazwę i po cichu przegapiać zlecenia.
--
-- CZEGO TA ZMIANA NIE ROBI: niczego nie oznacza w skrzynce. Graph zmienia stan przeczytania
-- wyłącznie przy jawnym zapisie (PATCH isRead), którego appka nigdzie nie wykonuje, a ścieżka IMAP
-- otwiera skrzynkę przez EXAMINE (tylko odczyt) i pobiera treść przez BODY.PEEK. Wymóg właściciela
-- "nie oznaczać jako odczytane" jest więc pilnowany na dwóch poziomach niezależnie od tej migracji.
--
-- ZAKRES REGUŁY — świadomie wąski: oznaczenie decyduje o tym, czy mail jest PROPOZYCJĄ NOWEGO
-- zlecenia. Mail powiązany z JUŻ ISTNIEJĄCYM zleceniem (odpowiedź w wątku, numer zlecenia albo
-- kontenera w treści) przechodzi dalej bez oznaczenia — inaczej zniknąłby wcześniejszy wymóg
-- właściciela: "nawet jak klient dośle informacje w treści/dodatkowym to program to zobaczy".
-- Nieoznaczone maile NIE GINĄ: zapisują się ze statusem `ignored` i powodem, więc widać je
-- w Skrzynce po zmianie filtra.
-- ============================================================

alter table public.email_messages
  add column if not exists categories text[] not null default '{}',
  add column if not exists flagged boolean not null default false;

-- Konfiguracja odpytywania siedzi przy stanie odczytu (jeden wiersz) — to nie są ustawienia
-- prywatne użytkownika (jak user_view_settings), tylko wspólna reguła dla całej firmy.
alter table public.email_ingest_state
  -- Domyślnie WŁĄCZONE, bo o to właśnie poprosił właściciel. Wyłączenie = appka proponuje każdy
  -- mail z PDF-em, czyli zachowanie sprzed tej zmiany.
  add column if not exists only_marked boolean not null default true,
  -- Puste = liczy się DOWOLNE oznaczenie (jakakolwiek kategoria albo flaga). Po pierwszym
  -- przebiegu właściciel może tu zostawić samą "czerwoną", klikając w Skrzynce.
  add column if not exists marked_categories text[] not null default '{}';

notify pgrst, 'reload schema';
