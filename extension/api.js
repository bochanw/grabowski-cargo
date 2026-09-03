// Rozmowa z Supabase: logowanie dyspozytora i wywołania funkcji `bhub-status`.
//
// Świadomie BEZ biblioteki `@supabase/supabase-js` — rozszerzenie ma być katalogiem plików, które
// da się wgrać do Chrome bez budowania czegokolwiek. Potrzebujemy dokładnie trzech zapytań HTTP,
// a doklejanie bundlera po to, żeby je opakować, kosztowałoby więcej, niż daje.
//
// Sesja siedzi w `chrome.storage.local`: token dostępu żyje godzinę, więc trzymamy też token
// odświeżający i wymieniamy go, ZANIM tamten wygaśnie (inaczej pierwszy przebieg po nocy padałby
// na 401 i wyglądał jak awaria terminala).

import { DOMYSLNE, ustawienia } from "./config.js";

const KLUCZ_SESJI = "sesja";

async function sesja() {
  const { [KLUCZ_SESJI]: s } = await chrome.storage.local.get(KLUCZ_SESJI);
  return s ?? null;
}

async function zapiszSesje(dane, email) {
  const s = {
    access_token: dane.access_token,
    refresh_token: dane.refresh_token,
    // Minuta zapasu: token wymieniamy chwilę przed końcem, a nie po nim.
    wygasa: Date.now() + Math.max(60, (dane.expires_in ?? 3600) - 60) * 1000,
    email: email ?? dane.user?.email ?? null,
  };
  await chrome.storage.local.set({ [KLUCZ_SESJI]: s });
  return s;
}

async function auth(sciezka, body) {
  const res = await fetch(`${DOMYSLNE.supabaseUrl}/auth/v1/${sciezka}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: DOMYSLNE.anonKey },
    body: JSON.stringify(body),
  });
  const dane = await res.json().catch(() => null);
  if (!res.ok || !dane?.access_token) {
    const powod = dane?.error_description || dane?.msg || dane?.message || `HTTP ${res.status}`;
    throw new Error(powod);
  }
  return dane;
}

export async function zaloguj(email, haslo) {
  const dane = await auth("token?grant_type=password", { email, password: haslo });
  return zapiszSesje(dane, email);
}

export async function wyloguj() {
  await chrome.storage.local.remove(KLUCZ_SESJI);
}

export async function konto() {
  const s = await sesja();
  return s ? { email: s.email } : null;
}

/** Ważny token dostępu — z odświeżeniem, gdy trzeba. Rzuca czytelnym błędem, gdy nikt nie jest zalogowany. */
export async function token() {
  const s = await sesja();
  if (!s?.refresh_token) throw new Error("Rozszerzenie nie jest zalogowane — otwórz je i podaj e-mail oraz hasło.");
  if (s.access_token && Date.now() < s.wygasa) return s.access_token;

  try {
    const dane = await auth("token?grant_type=refresh_token", { refresh_token: s.refresh_token });
    const nowa = await zapiszSesje(dane, s.email);
    return nowa.access_token;
  } catch (e) {
    // Token odświeżający też bywa unieważniony (zmiana hasła, wylogowanie wszędzie). Kasujemy
    // sesję, żeby okno rozszerzenia pokazało formularz logowania zamiast wiecznego błędu.
    await wyloguj();
    throw new Error(`Sesja rozszerzenia wygasła (${e.message}) — zaloguj się ponownie.`);
  }
}

/** Losowany raz identyfikator TEJ instalacji — po nim appka pozna, że rozszerzenie żyje. */
export async function agent() {
  const { agentId, etykieta } = await chrome.storage.local.get(["agentId", "etykieta"]);
  let id = agentId;
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ agentId: id });
  }
  let label = etykieta;
  if (!label) {
    const info = await chrome.runtime.getPlatformInfo().catch(() => null);
    label = `Chrome ${info?.os ?? ""}`.trim();
  }
  return { id, label };
}

export async function wywolaj(action, body = {}) {
  const dostep = await token();
  const res = await fetch(`${DOMYSLNE.supabaseUrl}/functions/v1/bhub-status`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${dostep}`, apikey: DOMYSLNE.anonKey },
    body: JSON.stringify({ action, agent: await agent(), ...body }),
  });
  if (res.status === 404) throw new Error("Funkcja bhub-status nie jest wdrożona na projekcie Supabase.");
  const dane = await res.json().catch(() => null);
  if (!dane || typeof dane.ok !== "boolean") throw new Error(`Nieoczekiwana odpowiedź serwera (HTTP ${res.status}).`);
  if (!dane.ok) throw new Error(dane.error || `Błąd funkcji (${dane.reason ?? "?"}).`);
  return dane;
}

export { ustawienia };
