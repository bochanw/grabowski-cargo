// ============================================================
// Microsoft Graph — odczyt skrzynki Exchange Online uwierzytelnieniem APLIKACYJNYM
// (client credentials), nie w imieniu zalogowanego człowieka.
//
// Dlaczego tak, a nie IMAP z loginem i hasłem: Microsoft wyłączył Basic Auth dla IMAP-a w Exchange
// Online z końcem 2022 r. Zostaje OAuth, a w wariancie aplikacyjnym:
//  - nic nie wygasa po 7 dniach i nie umiera przy zmianie hasła użytkownika (inaczej niż token
//    delegowany czy hasło aplikacji),
//  - nie trzeba trzymać niczyjego hasła,
//  - administrator może ZAWĘZIĆ aplikację do JEDNEJ skrzynki (ApplicationAccessPolicy) — bez tego
//    uprawnienie Mail.Read na poziomie aplikacji daje dostęp do wszystkich skrzynek w tenancie.
//    To jest wymóg do przekazania administratorowi, nie opcja.
//
// Uprawnienie: Mail.Read (typ APPLICATION, nie delegated) + zgoda administratora tenanta.
// Sekrety w Supabase: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAILBOX_ADDRESS.
//
// KURSOR: zamiast delty Graphowej używamy znacznika czasu ostatniej pobranej wiadomości.
// Powód: `/messages/delta` przy pierwszym wywołaniu przechodzi CAŁĄ skrzynkę (u klienta z historią
// to tysiące wiadomości i wiele stron), a my chcemy zacząć od ogona i pobierać po kilkanaście.
// Filtr po `receivedDateTime` daje to wprost i jest odporny na restart. Wiadomości z identycznym
// znacznikiem czasu nie zdublują się, bo `email_messages.message_id` ma UNIQUE — porównanie jest
// więc celowo `ge`, nie `gt` (lepiej powtórzyć i odbić się o UNIQUE niż zgubić wiadomość).
// ============================================================

import { type FetchResult, type MailAttachment, type MailSource, MailSourceError, type RawMessage } from "./mailSource.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
// Pierwszy przebieg na skrzynce, której jeszcze nie znamy: bierzemy ogon z ostatniej doby,
// a nie całą historię konta.
const INITIAL_LOOKBACK_HOURS = 24;
// Zabezpieczenie przed wciągnięciem do pamięci funkcji brzegowej wielkiego skanu wgranego przez
// pomyłkę — pojedyncze zlecenie to zwykle 1-3 strony.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  categories?: string[];
  flag?: { flagStatus?: string };
  from?: { emailAddress?: { address?: string; name?: string } };
  body?: { content?: string; contentType?: string };
}

interface GraphAttachment {
  "@odata.type"?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
}

export class GraphMailSource implements MailSource {
  readonly name = "Microsoft Graph (Exchange Online)";
  #config: GraphConfig;
  #token: string | null = null;

  constructor(config: GraphConfig) {
    this.#config = config;
  }

  async #accessToken(): Promise<string> {
    if (this.#token) return this.#token;
    const body = new URLSearchParams({
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      // `.default` = "wszystkie uprawnienia aplikacji, na które administrator już wyraził zgodę".
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const res = await fetch(`https://login.microsoftonline.com/${this.#config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
      // Komunikat Microsoftu bywa jedynym śladem, czego brakuje (zgody administratora, uprawnienia,
      // złego tenanta) — przepuszczamy go, ale bez sekretu klienta.
      const detail = data?.error_description ?? data?.error ?? `HTTP ${res.status}`;
      throw new MailSourceError(`Nie udało się uzyskać tokenu Microsoft: ${String(detail).slice(0, 300)}`);
    }
    this.#token = data.access_token as string;
    return this.#token;
  }

  async #get(url: string, plainTextBody = false): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.#accessToken()}` };
    // Bez tego Graph zwraca treść jako HTML i trzeba by ją odtagowywać po swojej stronie.
    if (plainTextBody) headers["Prefer"] = 'outlook.body-content-type="text"';
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      // Najczęstszy realny błąd na starcie: aplikacja nie ma dostępu do TEJ skrzynki, bo polityka
      // ApplicationAccessPolicy jej nie obejmuje albo obejmuje inną.
      throw new MailSourceError(`Microsoft Graph odmówił: ${String(detail).slice(0, 300)}`);
    }
    return (data ?? {}) as Record<string, unknown>;
  }

  async fetchSince(cursor: string, limit: number): Promise<FetchResult> {
    const since = cursor || new Date(Date.now() - INITIAL_LOOKBACK_HOURS * 3600_000).toISOString();
    const mailbox = encodeURIComponent(this.#config.mailbox);
    // `categories` i `flag` to oznaczenia nadane ręcznie w skrzynce — u klienta pracownik zaznacza
    // nimi zlecenia do wpisania. Samo ich POBRANIE niczego w skrzynce nie zmienia: Graph zmienia
    // stan wiadomości wyłącznie przy jawnym zapisie (PATCH), którego appka nigdzie nie robi.
    const select = "id,internetMessageId,conversationId,subject,receivedDateTime,hasAttachments,categories,flag,from,body";
    // +1 do limitu, żeby wiedzieć, czy zostało coś na kolejny przebieg, bez osobnego zapytania.
    const url =
      `${GRAPH}/users/${mailbox}/mailFolders/inbox/messages` +
      `?$select=${select}` +
      `&$filter=receivedDateTime ge ${since}` +
      `&$orderby=receivedDateTime asc` +
      `&$top=${limit + 1}`;

    const page = await this.#get(url, true);
    const all = (page.value ?? []) as GraphMessage[];
    const batch = all.slice(0, limit);

    const messages: RawMessage[] = [];
    for (const item of batch) {
      const attachments: MailAttachment[] = item.hasAttachments
        ? await this.#fetchPdfAttachments(mailbox, item.id)
        : [];
      messages.push({
        // internetMessageId jest stabilny między systemami; id Graphowe zmienia się przy
        // przeniesieniu wiadomości między folderami, więc jako klucz deduplikacji jest gorsze.
        messageId: item.internetMessageId || `graph-${item.id}`,
        // Graph sam grupuje wątek — conversationId jest pewniejszy niż składanie References.
        threadRefs: item.conversationId ? [item.conversationId] : [],
        fromEmail: item.from?.emailAddress?.address ?? "",
        fromName: item.from?.emailAddress?.name ?? "",
        subject: item.subject ?? "",
        bodyText: (item.body?.content ?? "").slice(0, 20_000),
        receivedAt: item.receivedDateTime ?? null,
        attachments,
        categories: item.categories ?? [],
        // "flagged" = do wykonania; "complete" znaczy, że ktoś już to odhaczył, więc nie jest to
        // sygnał "do wpisania".
        flagged: (item.flag?.flagStatus ?? "notFlagged") === "flagged",
      });
    }

    const lastReceived = batch.at(-1)?.receivedDateTime;
    return {
      messages,
      cursor: lastReceived ?? since,
      remaining: Math.max(0, all.length - batch.length),
    };
  }

  async #fetchPdfAttachments(mailbox: string, messageId: string): Promise<MailAttachment[]> {
    const data = await this.#get(
      `${GRAPH}/users/${mailbox}/messages/${messageId}/attachments?$select=id,name,contentType,size`,
    );
    const list = (data.value ?? []) as GraphAttachment[];
    const out: MailAttachment[] = [];
    for (const meta of list) {
      const name = meta.name ?? "";
      const isPdf = (meta.contentType ?? "").toLowerCase().includes("pdf") || /\.pdf$/i.test(name);
      // Tylko PDF-y i tylko plikowe załączniki: wiadomość załączona jako element (itemAttachment)
      // ani odsyłacz do OneDrive nie niosą bajtów pliku.
      if (!isPdf || meta["@odata.type"] === "#microsoft.graph.itemAttachment") continue;
      if (!meta.id || (meta.size ?? 0) > MAX_ATTACHMENT_BYTES) continue;
      // Pierwsze zapytanie ($select) daje tylko metryki — po bajty jedziemy OSOBNO i tylko po ten
      // jeden załącznik. Dzięki temu nie ściągamy podpisów graficznych ze stopki każdego maila
      // (`hasAttachments` jest prawdziwe także dla obrazków w treści).
      const full = await this.#get(`${GRAPH}/users/${mailbox}/messages/${messageId}/attachments/${meta.id}`);
      const contentBytes = (full as GraphAttachment).contentBytes;
      if (!contentBytes) continue;
      out.push({ filename: name || "zalacznik.pdf", bytes: decodeBase64(contentBytes) });
    }
    return out;
  }

  close(): void {
    this.#token = null;
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
