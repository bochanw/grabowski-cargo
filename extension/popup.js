// Okno rozszerzenia: logowanie, stan ostatniego przebiegu, „Sprawdź teraz" i dwa ustawienia.
// Cała robota dzieje się w `background.js` — tutaj są wyłącznie wiadomości do niego, żeby jedna
// i ta sama ścieżka obsługiwała klik z okna i prośbę z appki.

import { ustawienia } from "./config.js";

const $ = (id) => document.getElementById(id);
const wyslij = (wiadomosc) => chrome.runtime.sendMessage(wiadomosc);

function kiedy(iso) {
  if (!iso) return "nigdy";
  const minuty = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minuty < 1) return "przed chwilą";
  if (minuty < 60) return `${minuty} min temu`;
  const godziny = Math.round(minuty / 60);
  return godziny < 24 ? `${godziny} godz. temu` : `${Math.round(godziny / 24)} dni temu`;
}

async function odswiez() {
  const stan = await wyslij({ typ: "stan" });
  const zalogowany = Boolean(stan?.konto);
  $("logowanie").hidden = zalogowany;
  $("panel").hidden = !zalogowany;
  if (!zalogowany) return;

  const o = stan.ostatni;
  const opis = !o
    ? "Jeszcze nic nie sprawdzano."
    : o.blad
      ? `<span class="blad">Błąd (${kiedy(o.kiedy)}):</span> ${o.blad}`
      : `<span class="ok">Ostatnie sprawdzenie ${kiedy(o.kiedy)}</span> — kontenerów: ${o.sprawdzone ?? 0}` +
        (o.uwaga ? ` (${o.uwaga})` : "");

  $("stan").innerHTML =
    `${stan.trwa ? "<b>Sprawdzanie trwa…</b><br />" : ""}${opis}` +
    `<div class="drobne">Konto: ${stan.konto.email ?? "?"}</div>`;
  $("sprawdz").disabled = Boolean(stan.trwa);
}

$("zaloguj").addEventListener("click", async () => {
  $("bladLogowania").hidden = true;
  $("zaloguj").disabled = true;
  const wynik = await wyslij({ typ: "zaloguj", email: $("email").value.trim(), haslo: $("haslo").value });
  $("zaloguj").disabled = false;
  if (!wynik?.ok) {
    $("bladLogowania").textContent = wynik?.error ?? "Nie udało się zalogować.";
    $("bladLogowania").hidden = false;
    return;
  }
  $("haslo").value = "";
  await odswiez();
});

$("sprawdz").addEventListener("click", async () => {
  $("sprawdz").disabled = true;
  $("stan").textContent = "Sprawdzanie trwa…";
  const wynik = await wyslij({ typ: "sprawdz-teraz", powod: "okno rozszerzenia" });
  if (!wynik?.ok && wynik?.error) $("stan").innerHTML = `<span class="blad">${wynik.error}</span>`;
  await odswiez();
});

$("karta").addEventListener("click", async () => {
  const cfg = await ustawienia();
  const { kartaId } = await chrome.storage.local.get("kartaId");
  if (kartaId) {
    const karta = await chrome.tabs.get(kartaId).catch(() => null);
    if (karta) {
      await chrome.tabs.update(kartaId, { active: true });
      window.close();
      return;
    }
  }
  await chrome.tabs.create({ url: cfg.adresTerminala, pinned: true });
  window.close();
});

$("zapisz").addEventListener("click", async () => {
  await wyslij({ typ: "ustaw", wartosci: { adresTerminala: $("adres").value.trim(), etykieta: $("etykieta").value.trim() } });
  await odswiez();
});

$("wyloguj").addEventListener("click", async () => {
  await wyslij({ typ: "wyloguj" });
  await odswiez();
});

(async () => {
  const cfg = await ustawienia();
  $("adres").value = cfg.adresTerminala;
  $("etykieta").value = cfg.etykieta ?? "";
  await odswiez();
})();
