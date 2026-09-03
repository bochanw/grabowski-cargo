// ============================================================
// Źródło poczty przez IMAP — ścieżka dla LOKALNEGO serwera Exchange (on-premises), gdzie Basic Auth
// zwykle nadal działa. Dla Exchange Online ta droga jest zamknięta (Microsoft wyłączył Basic Auth
// dla IMAP-a z końcem 2022) — tam wchodzi graph.ts.
//
// Sam protokół siedzi w imap.ts (i ma własne testy przeciwko atrapie serwera); tutaj jest tylko
// doprowadzenie go do wspólnego kształtu `MailSource` i rozbiór MIME.
// ============================================================

import PostalMime from "npm:postal-mime@2.4.4";
import { ImapClient } from "./imap.ts";
import { type FetchResult, type MailAttachment, type MailSource, MailSourceError, type RawMessage } from "./mailSource.ts";

const INITIAL_BACKFILL = 20;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export class ImapMailSource implements MailSource {
  readonly name: string;
  #config: ImapConfig;
  #client = new ImapClient({ timeoutMs: 90_000 });

  constructor(config: ImapConfig) {
    this.#config = config;
    this.name = `IMAP (${config.host})`;
  }

  async fetchSince(cursor: string, limit: number): Promise<FetchResult> {
    const lastUid = Number(cursor || 0);
    await this.#client.connect(this.#config.host, this.#config.port);
    await this.#client.login(this.#config.user, this.#config.password);
    const mailbox = await this.#client.selectInbox();

    // Kursor koduje też UIDVALIDITY: gdy serwer przestawi "wcielenie" skrzynki, stare UID-y nie
    // znaczą nic i trzymanie się ich pobrałoby przypadkowe wiadomości.
    const [storedValidity, storedUid] = cursor.includes(":")
      ? cursor.split(":").map(Number)
      : [mailbox.uidValidity, lastUid];
    const startUid = storedValidity !== mailbox.uidValidity || !storedUid
      ? Math.max(0, mailbox.uidNext - 1 - INITIAL_BACKFILL)
      : storedUid;

    const allUids = await this.#client.searchAfter(startUid);
    const uids = allUids.slice(0, limit);

    const messages: RawMessage[] = [];
    let highest = startUid;
    for (const uid of uids) {
      const raw = await this.#client.fetchRaw(uid);
      highest = uid;
      if (!raw) continue;
      const mime = await PostalMime.parse(raw);

      const attachments: MailAttachment[] = [];
      for (const attachment of mime.attachments ?? []) {
        const filename = attachment.filename ?? "zalacznik.pdf";
        const isPdf = (attachment.mimeType ?? "").toLowerCase().includes("pdf") || /\.pdf$/i.test(filename);
        if (!isPdf) continue;
        // postal-mime zwraca treść jako ArrayBuffer, a dla części kodowań jako string base64.
        const bytes = typeof attachment.content === "string"
          ? decodeBase64(attachment.content)
          : new Uint8Array(attachment.content);
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
        attachments.push({ filename, bytes });
      }

      messages.push({
        messageId: mime.messageId ?? `imap-${mailbox.uidValidity}-${uid}`,
        threadRefs: [
          ...(mime.inReplyTo ? [mime.inReplyTo] : []),
          ...String(mime.references ?? "").split(/\s+/).filter(Boolean),
        ],
        fromEmail: mime.from?.address ?? "",
        fromName: mime.from?.name ?? "",
        subject: mime.subject ?? "",
        bodyText: (mime.text ?? "").slice(0, 20_000),
        receivedAt: mime.date ? new Date(mime.date).toISOString() : null,
        attachments,
      });
    }

    await this.#client.logout();
    return {
      messages,
      cursor: `${mailbox.uidValidity}:${highest}`,
      remaining: Math.max(0, allUids.length - uids.length),
    };
  }

  close(): void {
    this.#client.close();
  }
}

export function requireImapConfig(env: (key: string) => string | undefined): ImapConfig {
  const host = env("IMAP_HOST") ?? "";
  const user = env("IMAP_USER") ?? "";
  const password = env("IMAP_PASSWORD") ?? "";
  if (!host || !user || !password) {
    throw new MailSourceError("Brak sekretów IMAP_HOST / IMAP_USER / IMAP_PASSWORD w projekcie Supabase.");
  }
  return { host, user, password, port: Number(env("IMAP_PORT") ?? 993) };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
