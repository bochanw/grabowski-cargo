"use client";

// Własny ekran błędu zamiast domyślnego "This page couldn't load" Next.js — pokazuje TREŚĆ
// wyjątku, żeby zgłoszenie od dyspozytora od razu mówiło, co się wywaliło (pierwszy raz trzeba
// było zgadywać przyczynę z samego "nie ma takiej strony").
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-zinc-50 p-6 text-center dark:bg-black">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Coś poszło nie tak</h1>
      <p className="max-w-xl break-words rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        {error.message || String(error)}
        {error.digest ? ` (${error.digest})` : ""}
      </p>
      <p className="text-xs text-zinc-500">Prześlij ten komunikat, jeśli błąd się powtarza.</p>
      <div className="flex gap-2">
        <button type="button" onClick={reset} className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          Spróbuj ponownie
        </button>
        <button type="button" onClick={() => window.location.reload()} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
          Odśwież stronę
        </button>
      </div>
    </div>
  );
}
