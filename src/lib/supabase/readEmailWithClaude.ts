import { supabase } from "./client";
import { extractPdfText } from "@/lib/pdf/extractPdfText";
import type { LearningDocument } from "@/lib/orderTemplates/autoLearn";
import { parseOrderPdf, parseOrderText } from "./parseOrderPdf";
import { EMPTY_PARSED_ORDER, mergeParsedOrders, type ParsedOrder } from "@/types/parsedOrder";
import { previousWorkingDay } from "@/lib/dates/workingDays";
import type { EmailMessage } from "@/types/emailMessage";

// PŁATNY odczyt maila przez Claude — WYŁĄCZNIE po kliknięciu dyspozytora.
//
// Powód jest kosztowy i zmierzony: skrzynka robiła to sama, przy każdym przebiegu poller
// (co 2 minuty), a płaciła PRZED sprawdzeniem, czy mail już jest w bazie. Kursor Microsoft Graph
// celowo porównuje „>=" (lepiej powtórzyć wiadomość niż ją zgubić), więc te same maile wracały
// w kolejnych przebiegach i były odczytywane od nowa — 515 wywołań przez jedną noc, do wyczerpania
// środków w Claude Console.
//
// Teraz `mail-poll` robi wyłącznie rzeczy DARMOWE (prefiltr, znane szablony), a model rusza
// stąd — z kliknięcia człowieka, który patrzy na konkretny mail i wie, czego od niego chce.
//
// Wynik zapisujemy przy wiadomości (`parsed`/`parse_source`), więc drugie otwarcie tego samego
// maila NIC nie kosztuje. To jest cały powód, dla którego ta funkcja pisze do bazy, zamiast tylko
// zwracać dane do formularza.

export type OdczytResult =
  | { ok: true; parsed: ParsedOrder; source: string; warnings: string[]; documents: LearningDocument[] }
  | { ok: false; error: string };

/** Załącznik maila w Storage — tyle, ile trzeba, żeby pobrać plik i nazwać go w komunikacie. */
interface Zalacznik {
  filename: string | null;
  storage_path: string | null;
  bucket?: string | null;
}

async function pobierzPlik(zalacznik: Zalacznik): Promise<File | null> {
  if (!zalacznik.storage_path) return null;
  const { data, error } = await supabase.storage
    .from(zalacznik.bucket || "order-emails")
    .download(zalacznik.storage_path);
  if (error || !data) return null;
  return new File([data], zalacznik.filename || "zalacznik.pdf", { type: "application/pdf" });
}

/**
 * Czyta załączniki maila (a gdy ich nie ma — jego treść) przez Edge Function `parse-order-pdf`
 * i zapisuje wynik przy wiadomości.
 *
 * Kolejność ta sama co przy ręcznym imporcie: znane szablony przerobił już `mail-poll` za darmo,
 * więc tutaj z definicji trafiają tylko dokumenty, których nie umiemy odczytać inaczej.
 */
export async function readEmailWithClaude(mail: EmailMessage, zalaczniki: Zalacznik[]): Promise<OdczytResult> {
  const warnings: string[] = [];
  const sources: string[] = [];
  // Materiał do auto-nauki: mail przyszedł sam, więc bez tego zlecenia ze skrzynki NIGDY nie
  // nauczyłyby appki żadnego układu — a to właśnie one powtarzają się najczęściej.
  const documents: LearningDocument[] = [];
  let merged: ParsedOrder = mail.parsed ?? EMPTY_PARSED_ORDER;
  let cokolwiek = false;

  for (const zalacznik of zalaczniki) {
    const plik = await pobierzPlik(zalacznik);
    if (!plik) {
      warnings.push(`${zalacznik.filename ?? "załącznik"}: nie udało się pobrać pliku ze Skrzynki.`);
      continue;
    }
    const wynik = await parseOrderPdf(plik);
    if (!wynik.ok) {
      warnings.push(`${plik.name}: odczyt przez Claude nie zadziałał (${wynik.error}).`);
      continue;
    }
    if (wynik.parsed.rate_currency && wynik.parsed.rate_currency.toUpperCase() !== "PLN") {
      warnings.push(`${plik.name}: stawka w ${wynik.parsed.rate_currency}, appka zakłada PLN — sprawdź kwotę.`);
    }
    merged = mergeParsedOrders(merged, wynik.parsed);
    sources.push(`${plik.name} — odczyt przez Claude`);
    cokolwiek = true;
    // Tekst wyciągamy TERAZ, kiedy plik i tak jest pobrany. Skan bez warstwy tekstowej po prostu
    // nie da się nauczyć — nie jest to błąd odczytu (model dostał oryginalny PDF).
    try {
      const text = await extractPdfText(plik);
      if (text) documents.push({ text, fileName: plik.name, source: `${plik.name} — odczyt przez Claude` });
    } catch {
      // trudno — nauka jest dodatkiem, odczyt się udał
    }
  }

  // Mail bez załączników bywa samą informacją („rozładunek przesuwamy na piątek") — wtedy do
  // modelu idzie tekst, co kosztuje ułamek odczytu PDF-a.
  if (zalaczniki.length === 0 && (mail.body_text ?? "").trim()) {
    const tresc = [
      `Temat: ${mail.subject ?? ""}`,
      `Od: ${mail.from_name ?? ""} <${mail.from_email ?? ""}>`,
      "",
      mail.body_text ?? "",
    ].join("\n");
    const wynik = await parseOrderText(tresc);
    if (wynik.ok) {
      merged = mergeParsedOrders(merged, wynik.parsed);
      sources.push("treść maila — odczyt przez Claude");
      cokolwiek = true;
    } else {
      warnings.push(`Nie udało się odczytać treści maila przez Claude (${wynik.error}).`);
    }
  }

  if (!cokolwiek) {
    return { ok: false, error: warnings[0] ?? "Nie było czego odczytać (brak załączników i pustej treści)." };
  }

  // Domyślna „Data" = dzień roboczy przed rozładunkiem — ta sama reguła co przy ręcznym imporcie.
  if (!merged.load_date && merged.delivery_date) {
    merged = { ...merged, load_date: previousWorkingDay(merged.delivery_date) };
  }

  const source = sources.join(", ");
  const { error } = await supabase
    .from("email_messages")
    .update({
      parsed: merged,
      parse_source: source,
      warnings: [...mail.warnings.filter((w) => !w.includes("Odczytaj przez Claude")), ...warnings],
    })
    .eq("id", mail.id);

  // Zapis się nie udał, ale odczyt TAK — oddajemy dane do formularza, zamiast każać płacić drugi
  // raz. Dyspozytor straci najwyżej podgląd w Skrzynce po zamknięciu okna.
  if (error) warnings.push(`Odczyt się udał, ale nie zapisał się w Skrzynce: ${error.message}`);

  return { ok: true, parsed: merged, source, warnings, documents };
}
