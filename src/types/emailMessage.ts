import type { ParsedOrder } from "./parsedOrder";

// Mail ze skrzynki firmowej jako KANDYDAT na zlecenie — wiersz tabeli `email_messages`
// (migracje 0010/0011). Wypełnia go Edge Function `mail-poll`; appka tylko czyta i zmienia status.
//
// Kluczowa własność, wprost z decyzji właściciela: to jest KOLEJKA DO ZATWIERDZENIA, nie zapis.
// Nic z tego nie trafia do `loads`, dopóki dyspozytor nie kliknie — dlatego rekord trzyma odczytane
// pola (`parsed`) osobno od zleceń, razem z informacją, CZYM je odczytano (`parse_source`) i co
// przy tym budziło wątpliwości (`warnings`).
export type EmailStatus = "new" | "ignored" | "accepted" | "rejected" | "error";

export interface EmailMessage {
  id: string;
  message_id: string;
  thread_refs: string[];
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string | null;
  status: EmailStatus;
  /**
   * Oznaczenia nadane RĘCZNIE w skrzynce (migracja 0024). U klienta pracownik zaznacza kolorową
   * kategorią zlecenia „do wpisania" — `categories` to nazwy tych kategorii (dowolne, bo nadaje je
   * użytkownik Outlooka), `flagged` to flaga do wykonania. Zapisujemy je dla KAŻDEGO maila, także
   * pominiętego, żeby dało się zobaczyć, czym te wiadomości są naprawdę oznaczone.
   */
  categories: string[];
  flagged: boolean;
  /** Niepuste = mail dotyczy JUŻ ISTNIEJĄCEGO zlecenia (dopięcie/zmiana), puste = kandydat na nowe. */
  matched_load_id: string | null;
  match_reason: string | null;
  parsed: ParsedOrder | null;
  parse_source: string | null;
  warnings: string[];
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailAttachment {
  id: string;
  email_message_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  parse_source: string | null;
  error: string | null;
}

/** Stan odpytywania skrzynki — jeden wiersz. Służy głównie temu, żeby MARTWY ODCZYT BYŁO WIDAĆ. */
export interface EmailIngestState {
  id: boolean;
  cursor: string;
  source: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  seen_total: number;
  /** Czy propozycje nowych zleceń robimy TYLKO z maili oznaczonych przez człowieka. */
  only_marked: boolean;
  /** Puste = liczy się dowolne oznaczenie; niepuste = tylko te kategorie. */
  marked_categories: string[];
}
