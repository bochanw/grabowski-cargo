// ============================================================
// Wspólny kształt "źródła poczty" — Exchange Online przez Microsoft Graph albo serwer IMAP.
//
// Po co abstrakcja zamiast jednej implementacji: u klienta jest Exchange, ale nie zostało jeszcze
// potwierdzone, czy w chmurze (Microsoft 365) czy lokalny. Te dwa przypadki różnią się WYŁĄCZNIE
// sposobem pobrania wiadomości — cała reszta pollera (prefiltr, dopasowanie do zlecenia, odczyt
// szablonem/Claude, zapis do kolejki) jest identyczna. Interfejs niżej odcina tę różnicę w jednym
// miejscu, więc przełączenie źródła to zmiana zmiennej `MAIL_SOURCE`, nie przepisywanie funkcji.
// ============================================================

export interface RawMessage {
  /** Stabilny, globalnie unikalny identyfikator wiadomości — klucz deduplikacji (kolumna message_id). */
  messageId: string;
  /** Klucz wątku: conversationId z Graph albo References/In-Reply-To z IMAP-a. */
  threadRefs: string[];
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyText: string;
  receivedAt: string | null;
  attachments: MailAttachment[];
  /**
   * Oznaczenia nadane przez człowieka w skrzynce — u klienta to nimi pracownik mówi „to zlecenie
   * jest do wpisania". `categories` to kolorowe kategorie Outlooka (czerwony prostokąt przy
   * wiadomości; nazwy są dowolne, bo nadaje je użytkownik), `flagged` to flaga do wykonania.
   * Trzymamy OBA, bo z zewnątrz nie da się orzec, którego z nich klient używa.
   */
  categories: string[];
  flagged: boolean;
}

export interface MailAttachment {
  filename: string;
  bytes: Uint8Array;
}

/** Kursor przyrostowy — co źródło, to inny kształt, dlatego trzymany jako nieprzezroczysty tekst. */
export interface FetchResult {
  messages: RawMessage[];
  /** Nowy kursor do zapisania w email_ingest_state. */
  cursor: string;
  /** Ile wiadomości zostało jeszcze do pobrania (kolejny przebieg je weźmie). */
  remaining: number;
}

export interface MailSource {
  readonly name: string;
  /**
   * Wiadomości nowsze niż `cursor`. Pusty kursor = pierwszy przebieg: źródło ma wtedy pobrać
   * krótki ogon skrzynki, NIE całą historię konta.
   */
  fetchSince(cursor: string, limit: number): Promise<FetchResult>;
  close(): void;
}

export class MailSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSourceError";
  }
}
