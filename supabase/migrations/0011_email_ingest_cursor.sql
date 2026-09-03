-- ============================================================
-- Kursor odpytywania skrzynki niezależny od źródła poczty.
--
-- 0010 zakładała Gmaila po IMAP-ie, więc stan trzymał UID-y (`last_uid`, `uid_validity`). Klient
-- ma jednak Exchange, a tam (Exchange Online) Microsoft wyłączył Basic Auth dla IMAP-a z końcem
-- 2022 — odczyt idzie przez Microsoft Graph, którego kursorem jest znacznik czasu ostatniej
-- pobranej wiadomości, nie UID.
--
-- Zamiast dokładać kolejne kolumny per protokół, kursor jest teraz JEDNYM polem tekstowym, którego
-- kształt zna wyłącznie źródło poczty (`supabase/functions/mail-poll/mailSource.ts`): Graph zapisuje
-- tam datę ISO, IMAP „uidvalidity:uid". Dzięki temu zmiana albo dołożenie źródła nie wymaga migracji.
-- `source` jest wyłącznie informacyjne — żeby w UI było widać, skąd faktycznie czytamy.
--
-- Stare kolumny są USUWANE, nie zostawiane „na wszelki wypadek": 0010 nie zdążyła zebrać żadnych
-- danych (poller nigdy nie wystartował — brak sekretów), więc nie ma czego migrować, a dwa
-- równoległe kursory to gwarantowane źródło pomyłki przy następnej zmianie.
-- ============================================================

alter table public.email_ingest_state
  add column if not exists cursor text not null default '',
  add column if not exists source text;

alter table public.email_ingest_state
  drop column if exists last_uid,
  drop column if exists uid_validity;

-- `imap_uid` na wiadomości też był specyficzny dla IMAP-a; identyfikacja i dedup i tak stoją na
-- `message_id` (UNIQUE), a numer sekwencyjny nie niesie nic, czego nie ma `received_at`.
alter table public.email_messages
  drop column if exists imap_uid;
