import { supabase } from "./client";

/**
 * Podpisany URL do pliku w Storage. Oba buckety appki są PRYWATNE (`load-documents` — dokumenty
 * zleceń, `order-emails` — załączniki maili zapisane przez `mail-poll`), więc bez podpisu nie da
 * się pokazać pliku ani w nowej karcie, ani w ramce podglądu.
 *
 * Wydzielone z hooka dokumentów, bo z tego samego mechanizmu korzysta teraz podgląd ŹRÓDŁA przy
 * odczycie zlecenia (właściciel: "odczytując zlecenia z maila nie widzę źródła — nie jestem
 * w stanie skorygować błędów"), a tam plik leży w buckecie maili, nie zleceń.
 */
export const SIGNED_URL_SECONDS = 60 * 60;

export async function signedStorageUrl(
  bucket: string,
  path: string,
  seconds: number = SIGNED_URL_SECONDS
): Promise<{ url: string } | { error: string }> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, seconds);
  if (error || !data) return { error: error?.message ?? "Nie udało się otworzyć pliku." };
  return { url: data.signedUrl };
}
