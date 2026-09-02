"use client";

import { useSession } from "@/hooks/useSession";
import { supabase } from "@/lib/supabase/client";
import { LoginForm } from "./LoginForm";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useSession();

  if (isLoading) {
    return <div className="flex flex-1 items-center justify-center text-zinc-500">Wczytywanie…</div>;
  }

  if (!session) {
    return <LoginForm />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end gap-3 border-b border-zinc-200 bg-white px-4 py-1 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500">
        <span>{session.user.email}</span>
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Wyloguj
        </button>
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
