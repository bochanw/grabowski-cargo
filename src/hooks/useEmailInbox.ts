"use client";

import { useEffect, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase/client";
import type { EmailIngestState, EmailMessage, EmailStatus } from "@/types/emailMessage";

export const EMAIL_INBOX_QUERY_KEY = ["email_messages"] as const;
export const EMAIL_INGEST_STATE_QUERY_KEY = ["email_ingest_state"] as const;
const LIMIT = 100;

async function fetchInbox(): Promise<EmailMessage[]> {
  // Maile odsiane przez prefiltr (`ignored`) nie zaśmiecają Skrzynki — dyspozytor ma widzieć to,
  // co wymaga jego decyzji, a nie każdą wiadomość, która przyszła na firmową skrzynkę.
  const { data, error } = await supabase
    .from("email_messages")
    .select("*")
    .in("status", ["new", "error"])
    .order("received_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

/**
 * Maile POMINIĘTE przez prefiltr — normalnie niewidoczne, bo Skrzynka ma pokazywać to, co wymaga
 * decyzji. Odkąd propozycje robimy tylko z maili OZNACZONYCH przez człowieka (migracja 0024), musi
 * być jednak sposób, żeby zobaczyć, co odpadło i CZYM te wiadomości są oznaczone — inaczej reguła
 * byłaby czarną skrzynką, a przegapione zlecenie nie do wyśledzenia.
 */
async function fetchSkipped(): Promise<EmailMessage[]> {
  const { data, error } = await supabase
    .from("email_messages")
    .select("*")
    .eq("status", "ignored")
    .order("received_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export function useSkippedEmails(enabled: boolean) {
  return useQuery({ queryKey: ["email-skipped"], queryFn: fetchSkipped, enabled });
}

async function fetchIngestState(): Promise<EmailIngestState | null> {
  const { data, error } = await supabase.from("email_ingest_state").select("*").eq("id", true).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Skrzynka na żywo. Ten sam wzorzec co useLoads/useActivityLog: Realtime → setQueryData,
 * reconnect → refetch. Nazwa kanału z `useId()`, bo `supabase.channel(nazwa)` zwraca ISTNIEJĄCĄ
 * instancję dla powtórzonej nazwy, a drugie `.on(...).subscribe()` na niej rzuca wyjątek
 * (pułapka złapana na produkcji przy ContractorsDialog — patrz CLAUDE.md).
 */
export function useEmailInbox() {
  const queryClient = useQueryClient();
  const channelId = useId();
  const query = useQuery({ queryKey: EMAIL_INBOX_QUERY_KEY, queryFn: fetchInbox });

  useEffect(() => {
    let subscribedBefore = false;
    const channel = supabase
      .channel(`email-messages-changes-${channelId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "email_messages" }, (payload) => {
        queryClient.setQueryData<EmailMessage[]>(EMAIL_INBOX_QUERY_KEY, (current) => {
          if (!current) return current;
          if (payload.eventType === "INSERT") {
            const row = payload.new as EmailMessage;
            // Wiersze `ignored` wstawia poller przy każdym przebiegu — do Skrzynki nie wchodzą.
            if (row.status !== "new" && row.status !== "error") return current;
            if (current.some((m) => m.id === row.id)) return current;
            return [row, ...current].slice(0, LIMIT);
          }
          if (payload.eventType === "UPDATE") {
            const row = payload.new as EmailMessage;
            // Zaakceptowany/odrzucony znika ze Skrzynki — także wtedy, gdy zrobił to ktoś inny.
            if (row.status !== "new" && row.status !== "error") return current.filter((m) => m.id !== row.id);
            return current.map((m) => (m.id === row.id ? row : m));
          }
          if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as Partial<EmailMessage>).id;
            return current.filter((m) => m.id !== deletedId);
          }
          return current;
        });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (subscribedBefore) queryClient.invalidateQueries({ queryKey: EMAIL_INBOX_QUERY_KEY });
          subscribedBefore = true;
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return query;
}

/**
 * Stan odpytywania skrzynki. Osobny hook, bo interesuje nas głównie JEDNO: czy odczyt jeszcze
 * żyje. Hasło aplikacji/sekret klienta potrafi przestać działać (rotacja, zmiana hasła, cofnięta
 * zgoda administratora) — bez tego appka po prostu przestałaby dostawać zlecenia i nikt by nie
 * zauważył, że to awaria, a nie cisza w skrzynce.
 */
export function useIngestState() {
  const queryClient = useQueryClient();
  const channelId = useId();
  const query = useQuery({ queryKey: EMAIL_INGEST_STATE_QUERY_KEY, queryFn: fetchIngestState });

  useEffect(() => {
    const channel = supabase
      .channel(`email-ingest-state-${channelId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "email_ingest_state" }, (payload) => {
        queryClient.setQueryData(EMAIL_INGEST_STATE_QUERY_KEY, payload.new as EmailIngestState);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, channelId]);

  return query;
}

/** Zmiana statusu maila (zaakceptowany/odrzucony). Optymistycznie, z cofnięciem przy błędzie. */
/**
 * Reguła „czytaj tylko oznaczone" (migracja 0024) — wspólna dla całej firmy, więc siedzi przy
 * stanie odczytu, a nie w prywatnych ustawieniach widoku. Zapis idzie przez zwykły UPDATE, a zmianę
 * widzą pozostali dyspozytorzy przez Realtime na `email_ingest_state`.
 */
export function useSetIngestMarking() {
  const queryClient = useQueryClient();
  return async function setMarking(patch: { only_marked?: boolean; marked_categories?: string[] }): Promise<string | null> {
    const { error } = await supabase.from("email_ingest_state").update(patch).eq("id", true);
    if (error) return error.message;
    queryClient.invalidateQueries({ queryKey: EMAIL_INGEST_STATE_QUERY_KEY });
    return null;
  };
}

export function useSetEmailStatus() {
  const queryClient = useQueryClient();

  return async function setStatus(id: string, status: EmailStatus): Promise<string | null> {
    const previous = queryClient.getQueryData<EmailMessage[]>(EMAIL_INBOX_QUERY_KEY);
    queryClient.setQueryData<EmailMessage[]>(EMAIL_INBOX_QUERY_KEY, (current) =>
      current?.filter((m) => m.id !== id),
    );
    const { error } = await supabase.from("email_messages").update({ status }).eq("id", id);
    if (error) {
      queryClient.setQueryData(EMAIL_INBOX_QUERY_KEY, previous);
      return error.message;
    }
    return null;
  };
}

/**
 * Ręczne „Sprawdź teraz". Poza harmonogramem pg_cron — dyspozytor, który WIE, że klient właśnie
 * wysłał zlecenie, nie ma czekać do następnego przebiegu.
 */
export async function triggerMailPoll(): Promise<{ ok: boolean; message: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return { ok: false, message: "Brak aktywnej sesji — zaloguj się ponownie." };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return { ok: false, message: "Brak skonfigurowanego adresu Supabase." };

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/mail-poll`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({}),
    });
    if (res.status === 404) {
      return { ok: false, message: "Funkcja mail-poll nie jest wdrożona na projekcie Supabase." };
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data.ok !== "boolean") {
      return { ok: false, message: `Nieoczekiwana odpowiedź serwera (HTTP ${res.status}).` };
    }
    if (!data.ok) return { ok: false, message: String(data.error ?? "Nieznany błąd odczytu skrzynki.") };
    return {
      ok: true,
      message: `Sprawdzono ${data.sprawdzono ?? 0} wiadomości: ${data.doSkrzynki ?? 0} do Skrzynki, ${data.pominieto ?? 0} pominiętych.`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
