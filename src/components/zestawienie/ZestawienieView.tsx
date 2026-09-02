"use client";

import { useLoads } from "@/hooks/useLoads";
import { ZestawienieTable } from "./ZestawienieTable";

export function ZestawienieView() {
  const { data, isLoading, isError, error } = useLoads();

  if (isLoading) {
    return <div className="p-6 text-zinc-500">Wczytywanie zestawienia…</div>;
  }

  if (isError) {
    return (
      <div className="p-6 text-red-600">
        Błąd wczytywania zestawienia: {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }

  return <ZestawienieTable loads={data ?? []} />;
}
