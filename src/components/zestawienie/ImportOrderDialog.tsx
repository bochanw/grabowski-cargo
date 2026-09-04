"use client";

import { useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { extractPdfText } from "@/lib/pdf/extractPdfText";
import { parseOrderPdf } from "@/lib/supabase/parseOrderPdf";
import { matchKnownTemplate } from "@/lib/orderTemplates";
import { matchLearnedTemplate } from "@/lib/orderTemplates/readTemplate";
import type { LearningDocument } from "@/lib/orderTemplates/autoLearn";
import { useLearnFromDocuments, useOrderTemplates } from "@/hooks/useOrderTemplates";
import { PICKUP_LOCATIONS } from "@/lib/orderTemplates/pickupLocations";
import { previousWorkingDay } from "@/lib/dates/workingDays";
import { EMPTY_FLEET, reconcileWithFleet, useFleet, withCurrentOption, type Fleet } from "@/lib/fleet/fleetStore";
import { useContractors } from "@/hooks/useContractors";
import { findContractorByName, type Contractor } from "@/types/contractor";
import { EMPTY_PARSED_ORDER, mergeParsedOrders, type ParsedOrder } from "@/types/parsedOrder";
import { canOverwriteGrossWeight, computeGrossWeightKg } from "@/lib/containers/tare";
import { describeBafSplit, splitBaf } from "@/lib/invoice/baf";
import { shippingLineForNotes } from "@/lib/loads/leasing";
import { matchExistingLoad, type LoadMatch } from "@/lib/loads/orderNumber";
import { useUploadLoadDocument } from "@/hooks/useLoadDocuments";
import { DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, guessDocumentKind, type DocumentKind } from "@/types/loadDocument";
import type { Direction, Load } from "@/types/load";

type Stage = "pick" | "parsing" | "review" | "saving";

/** Wgrany plik czekający na zapis zlecenia — dopiero wtedy wiadomo, do jakiego id go podpiąć. */
interface PendingAttachment {
  file: File;
  kind: DocumentKind;
  /** Czym go odczytano ("szablon Q4Road", "odczyt przez Claude"); null = nie udało się odczytać. */
  parseSource: string | null;
}

const DEFAULT_CARRIER = "Grabowski Mariusz Sp. z o.o.";

// Ten sam formularz służy do importu (insert), dopięcia dokumentu do istniejącego zlecenia
// (update, wypełnia tylko puste pola) i — gdyby wrócił do UI — edycji "wszystkiego naraz".
function loadToForm(load: Load): ParsedOrder {
  return {
    order_number: load.order_number ?? "",
    forwarder: load.forwarder ?? "",
    // Dane spedytora nie są trzymane na zleceniu (żyją w contractors) — przy edycji/dopięciu puste.
    forwarder_nip: "",
    forwarder_address: "",
    forwarder_postal_code: "",
    forwarder_city: "",
    direction: load.direction,
    container_number: load.container_number ?? "",
    container_size: load.container_size ?? "",
    shipping_line: load.shipping_line ?? "",
    company_name: load.company_name ?? "",
    address: load.address ?? "",
    city: load.city ?? "",
    load_date: load.load_date ?? "",
    delivery_date: load.secondary_date ?? "",
    delivery_time: load.time_of_day ?? "",
    customs_location_or_status: load.customs_status ?? "",
    // Stawka w formularzu to kwota RAZEM (baza + BAF) — z rozbicia zapisanego przy zleceniu wraca
    // dokładnie ta sama liczba, którą podał dokument, a formToRow rozbije ją z powrotem.
    rate_amount: load.total_amount ?? load.invoice_amount,
    rate_currency: "",
    baf_percentage: load.baf_percentage,
    rate_includes_baf: load.baf_amount === null ? null : true,
    payment_terms_days: load.payment_terms_days,
    payment_terms_note: load.payment_terms_note ?? "",
    notes: load.notes ?? "",
    pickup_type: load.pickup_type ?? "",
    pin_booking: load.pin_booking ?? "",
    seal_number: load.seal_number ?? "",
    goods_name: load.goods_name ?? "",
    net_weight_kg: load.net_weight_kg,
    gross_weight: load.gross_weight ?? "",
    submitted_when: load.submitted_when ?? "",
    submitted_where: load.submitted_where ?? "",
    driver_name: load.driver_name ?? "",
    driver_id_number: load.driver_id_number ?? "",
    vehicle_plate: load.vehicle_plate ?? "",
    trailer_plate: load.trailer_plate ?? "",
    driver_phone: load.driver_phone ?? "",
  };
}

function formToRow(form: ParsedOrder, carrierName: string, contractorId: string) {
  // BAF: dokument podaje albo stawkę Z dodatkiem ("3 000, w tym BAF 13%"), albo bazę + procent —
  // do bazy idzie zawsze rozbicie, żeby faktura mogła pokazać BAF osobną pozycją, gdy kontrahent
  // tak ma ustawione. `invoice_amount` (kwota do zafakturowania) zostaje kwotą RAZEM.
  const split = splitBaf(form.rate_amount, form.baf_percentage, form.rate_includes_baf === true);
  return {
    contractor_id: contractorId || null,
    order_number: form.order_number || null,
    forwarder: form.forwarder || null,
    direction: form.direction as Direction,
    container_number: form.container_number || null,
    container_size: form.container_size || null,
    shipping_line: form.shipping_line || null,
    company_name: form.company_name || null,
    address: form.address || null,
    city: form.city || null,
    load_date: form.load_date || null,
    secondary_date: form.delivery_date || null,
    time_of_day: form.delivery_time || null,
    customs_status: form.customs_location_or_status || null,
    invoice_amount: split.total,
    freight_base_amount: split.base,
    baf_percentage: form.baf_percentage,
    baf_amount: split.baf,
    total_amount: split.total,
    payment_terms_days: form.payment_terms_days,
    payment_terms_note: form.payment_terms_note || null,
    notes: form.notes || null,
    carrier_name: carrierName || null,
    pickup_type: form.pickup_type || null,
    pin_booking: form.pin_booking || null,
    seal_number: form.seal_number || null,
    goods_name: form.goods_name || null,
    net_weight_kg: form.net_weight_kg,
    gross_weight: form.gross_weight || null,
    submitted_when: form.submitted_when || null,
    submitted_where: form.submitted_where || null,
    driver_name: form.driver_name || null,
    driver_id_number: form.driver_id_number || null,
    vehicle_plate: form.vehicle_plate || null,
    trailer_plate: form.trailer_plate || null,
    driver_phone: form.driver_phone || null,
  };
}

export function ImportOrderDialog({
  onClose,
  onSaved,
  existingLoad,
  initialParsed,
  mode = existingLoad ? "edit" : "import",
  recentLoads = [],
  onLearned,
  initialLearningDocs = [],
}: {
  onClose: () => void;
  /**
   * Wywoływane PO udanym zapisie, przed zamknięciem — Skrzynka oznacza tak maila jako
   * zaakceptowanego i podpina jego załączniki do zapisanego zlecenia (stąd `loadId`).
   */
  onSaved?: (loadId: string) => void | Promise<void>;
  existingLoad?: Load;
  /**
   * Pola odczytane już wcześniej, poza tym oknem — dziś ze Skrzynki (mail przeczytany serwerowo
   * przez `mail-poll`). Formularz startuje wtedy od razu w trybie przeglądu, bo nie ma czego
   * wgrywać: dokument został przeczytany, zanim dyspozytor kliknął.
   */
  initialParsed?: ParsedOrder;
  /** "attach" = dopnij kolejny dokument do istniejącego zlecenia (wypełnia tylko puste pola). */
  mode?: "import" | "edit" | "attach";
  /** Istniejące zlecenia od najnowszego — fallback "z poprzedniego zlecenia" dla pól floty. */
  recentLoads?: Load[];
  /** Co appka wyniosła z tego zapisu dla przyszłych dokumentów (auto-nauka szablonów). */
  onLearned?: (notes: string[]) => void;
  /**
   * Teksty dokumentów odczytanych POZA tym oknem (Skrzynka) — żeby zlecenie z maila uczyło appkę
   * tak samo jak wgrane ręcznie. Bez tego nauka pomijałaby najczęstszą drogę zleceń.
   */
  initialLearningDocs?: LearningDocument[];
}) {
  const { data: fleetData } = useFleet();
  const fleet: Fleet = fleetData ?? EMPTY_FLEET;
  const { data: contractors = [] } = useContractors();
  // Pola ze Skrzynki są już odczytane, więc ekran wyboru pliku byłby tylko przeszkodą.
  const [stage, setStage] = useState<Stage>(mode === "edit" || initialParsed ? "review" : "pick");
  const [form, setForm] = useState<ParsedOrder>(() => {
    const base = existingLoad ? loadToForm(existingLoad) : EMPTY_PARSED_ORDER;
    // Te same reguły scalania co przy dopinaniu drugiego dokumentu: dane z maila wypełniają TYLKO
    // puste pola, nigdy nie nadpisują tego, co już stoi na zleceniu.
    return initialParsed ? mergeParsedOrders(base, initialParsed) : base;
  });
  const [carrierName, setCarrierName] = useState(existingLoad?.carrier_name ?? DEFAULT_CARRIER);
  const [contractorId, setContractorId] = useState(existingLoad?.contractor_id ?? "");
  const [recognized, setRecognized] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Zlecenie rozpoznane po numerze wśród już istniejących — wtedy zapis UZUPEŁNIA je zamiast
  // tworzyć drugi rekord. `forceNew` to świadome "nie, to jednak inne zlecenie" dyspozytora.
  const [matchedLoad, setMatchedLoad] = useState<Load | null>(null);
  // Skojarzenie ZA SŁABE, żeby scalać samemu (ten sam kontener przy innym numerze, albo te same
  // człony numeru przy sprzecznym kontenerze) — pokazujemy je i czekamy na decyzję dyspozytora.
  const [suggested, setSuggested] = useState<LoadMatch<Load> | null>(null);
  // Zlecenia, przy których dyspozytor powiedział już "to inne zlecenie" — inaczej ta sama
  // podpowiedź wracałaby przy każdym kliknięciu "Zapisz" i nie dałoby się utworzyć rekordu.
  const [dismissedMatches, setDismissedMatches] = useState<string[]>([]);
  const [forceNew, setForceNew] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const uploadDocument = useUploadLoadDocument();
  const { data: orderTemplates = [] } = useOrderTemplates();
  const learnFromDocuments = useLearnFromDocuments();
  // Teksty wgranych dokumentów — appka uczy się z nich DOPIERO po udanym zapisie, kiedy wiadomo,
  // co dyspozytor faktycznie zatwierdził (patrz src/lib/orderTemplates/autoLearn.ts).
  const [learningDocs, setLearningDocs] = useState<LearningDocument[]>(initialLearningDocs);

  // Jedno zlecenie to u klienta zwykle DWA dokumenty (zlecenie spedycyjne + list przewozowy dla
  // kierowcy) — można wgrać oba naraz albo dopiąć drugi później (także do już zapisanego zlecenia);
  // każdy kolejny dokument wypełnia TYLKO puste pola, więc nie nadpisuje ręcznych poprawek.
  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setStage("parsing");
    setSaveError(null);

    let merged = form;
    const newRecognized: string[] = [];
    const newWarnings: string[] = [];

    // Pola z każdego kolejnego dokumentu wchodzą tą samą drogą, niezależnie od tego, czy przeczytał
    // go znany szablon czy Claude — te same ostrzeżenia i to samo scalanie "tylko puste pola".
    function absorb(parsed: ParsedOrder, fileName: string, source: string) {
      if (merged.order_number && parsed.order_number && merged.order_number !== parsed.order_number) {
        newWarnings.push(`${fileName}: numer zlecenia ${parsed.order_number} różni się od już wczytanego ${merged.order_number} — sprawdź, czy to to samo zlecenie.`);
      }
      if (parsed.rate_currency && parsed.rate_currency.toUpperCase() !== "PLN") {
        newWarnings.push(`${fileName}: stawka w ${parsed.rate_currency}, appka dziś zakłada PLN — sprawdź kwotę.`);
      }
      merged = mergeParsedOrders(merged, parsed);
      newRecognized.push(source);
    }

    // Oryginały PDF zostają przy zleceniu (właściciel: "po imporcie zleceń oryginalne PDF zostaną
    // zachowane jako załączniki") — KAŻDY wgrany plik, także ten, którego nie udało się odczytać:
    // dyspozytor przepisze z niego pola ręcznie, ale sam dokument ma być pod ręką.
    const newAttachments: PendingAttachment[] = [];
    const newLearningDocs: LearningDocument[] = [];

    for (const file of files) {
      setProgress(`Odczytywanie ${file.name}…`);
      let text = "";
      let extractError = "";
      try {
        text = await extractPdfText(file);
      } catch (e) {
        // Nie kończymy na tym: plik bez warstwy tekstowej (skan) i tak może przeczytać Claude,
        // który dostaje oryginalny PDF, a nie wyciągnięty tekst.
        extractError = e instanceof Error ? e.message : String(e);
      }

      // 1. Znane szablony klientów (regex na tekście z pdf.js) — pierwsze, bo są darmowe,
      //    natychmiastowe i deterministyczne. Do modelu idzie tylko to, czego nie umiemy sami.
      const match = text ? matchKnownTemplate(text) : null;
      let source: string | null = null;
      let usedTemplateId: string | undefined;
      let templateOutput: ParsedOrder | undefined;
      if (match) {
        absorb(match.parsed, file.name, match.name);
        source = match.name;
      } else {
        // 2. Szablon NAUCZONY z wcześniejszych zleceń tego spedytora — też darmowy i
        //    deterministyczny, więc idzie przed modelem. Wchodzi tylko wtedy, gdy odczytał komplet
        //    kluczowych pól (decyzja właściciela); niekompletny odczyt oddaje sprawę Claude'owi,
        //    zamiast zostawiać dziury w zleceniu.
        const learned = text ? matchLearnedTemplate(text, orderTemplates) : null;
        if (learned && learned.missing.length === 0) {
          source = learned.template.label;
          usedTemplateId = learned.template.id;
          templateOutput = learned.parsed;
          absorb(learned.parsed, file.name, source);
        } else {
          if (learned) {
            newWarnings.push(
              `${file.name}: nauczony szablon „${learned.template.label}" nie odczytał kompletu pól (brakuje: ${learned.missing.join(", ")}) — czytam ten dokument przez Claude.`
            );
          }
          // 3. Fallback: odczyt przez Claude (Edge Function parse-order-pdf). Nierozpoznany dokument
          //    nadal nie jest błędem — jeśli i to nie zadziała, pola zostają do ręcznego wpisania.
          setProgress(`${file.name}: nieznany szablon — czytam przez Claude…`);
          const result = await parseOrderPdf(file);
          if (result.ok) {
            source = `${file.name} — odczyt przez Claude`;
            absorb(result.parsed, file.name, source);
          } else {
            newWarnings.push(
              extractError
                ? `${file.name}: nie udało się odczytać pliku PDF (${extractError}), a odczyt przez Claude nie zadziałał (${result.error}) — wpisz pola z tego dokumentu ręcznie.`
                : `${file.name}: nie rozpoznano znanego szablonu, a odczyt przez Claude nie zadziałał (${result.error}) — wpisz pola z tego dokumentu ręcznie.`
            );
          }
        }
      }
      newAttachments.push({ file, kind: guessDocumentKind(file.name, source), parseSource: source });
      // Materiał do nauki zbieramy dla KAŻDEGO dokumentu z warstwą tekstową — także wpisanego
      // ręcznie po nieudanym odczycie: to wtedy dyspozytor podaje appce wzorcowe wartości.
      if (text) {
        newLearningDocs.push({
          text,
          fileName: file.name,
          source: source ?? "wpisane ręcznie",
          usedTemplateId,
          templateOutput,
        });
      }
    }
    setProgress("");

    // Domyślna "Data" = dzień roboczy przed rozładunkiem/załadunkiem z dokumentu.
    if (!merged.load_date && merged.delivery_date) {
      merged = { ...merged, load_date: previousWorkingDay(merged.delivery_date) };
    }
    // Brutto = towar + tara kontenera — po scaleniu dokumentów (typ kontenera może przyjść z jednego,
    // waga towaru z drugiego).
    merged = withRecomputedGross(merged, "net_weight_kg");

    // Gestia z uwag: kontener leasingowy nie ma armatora, a informacja o leasingu stoi w uwagach.
    const beforeLeasing = merged.shipping_line;
    merged = withLeasingShippingLine(merged);
    if (merged.shipping_line !== beforeLeasing) {
      newWarnings.push(
        beforeLeasing
          ? `Uwagi wspominają o leasingu — gestię przestawiono z "${beforeLeasing}" na "Leasing".`
          : "Uwagi wspominają o leasingu — gestię ustawiono na „Leasing”."
      );
    }

    // ROZPOZNANIE ZLECENIA PO NUMERZE (właściciel: "każde zlecenie jest rozpoznawane do nr
    // zlecenia — wtedy nie będzie potrzeby dodawać kolejnych dokumentów; jak wgramy drugi dokument
    // do tego samego zlecenia, to po prostu dociągną się brakujące dane"). Numer jest u klienta
    // unikalny, więc dokument z tym samym numerem NIE tworzy drugiego rekordu: wchodzimy w tryb
    // uzupełniania istniejącego, gdzie dane już zapisane WYGRYWAJĄ, a dokument wypełnia tylko puste.
    //
    // Numer bywa w dokumentach poskładany inaczej ("KPB / 87" i "87 / KPB" to u klienta jedno
    // zlecenie), a gdy i to nie trafi, zostaje numer kontenera — ten jednak tylko PODPOWIADA, bo
    // ten sam kontener wraca po tygodniach na inne zlecenie (patrz `auto` w matchExistingLoad).
    if (!existingLoad && !forceNew && !matchedLoad) {
      const match = matchExistingLoad(recentLoads, {
        order_number: merged.order_number,
        container_number: merged.container_number,
      });
      if (match?.auto) {
        const found = match.load;
        setMatchedLoad(found);
        merged = mergeParsedOrders(loadToForm(found), merged);
        if (found.contractor_id) setContractorId(found.contractor_id);
        if (found.carrier_name) setCarrierName(found.carrier_name);
        newWarnings.push(
          `Zlecenie ${found.order_number ?? ""} już jest w Zestawieniu (${match.reason}) — dokument uzupełni w nim brakujące pola zamiast tworzyć drugi rekord. Jeśli to jednak inne zlecenie, kliknij „Utwórz mimo to nowe zlecenie”.`
        );
      } else if (match && !dismissedMatches.includes(match.load.id)) {
        setSuggested(match);
      }
    }

    // Kierowca/pojazdy: dopasowanie do Panelu floty, fallback z poprzedniego zlecenia.
    const reconciled = reconcileWithFleet(merged, fleet, recentLoads);
    newWarnings.push(...reconciled.warnings);
    let order = reconciled.order;

    // Kontrahent: spedytor z dokumentu → skonfigurowany kontrahent (po nazwie/aliasach). Jego
    // domyślny termin płatności wchodzi TYLKO, gdy dokument go nie podał. Brak dopasowania to nie
    // problem dyspozytora: kontrahent założy się sam przy zapisie (patrz handleSave).
    if (!contractorId && order.forwarder) {
      const contractor = findContractorByName(contractors, order.forwarder);
      if (contractor) {
        setContractorId(contractor.id);
        order = applyContractorDefaults(order, contractor, newWarnings);
      } else {
        newWarnings.push(`Spedytor "${order.forwarder}" nie ma jeszcze kontrahenta — zostanie założony automatycznie przy zapisie (z NIP-em, adresem i terminem płatności z dokumentu). E-mail do faktur uzupełnij potem w "Kontrahenci".`);
      }
    }

    const allRecognized = [...recognized, ...newRecognized];
    setAttachments((prev) => [...prev, ...newAttachments]);
    setLearningDocs((prev) => [...prev, ...newLearningDocs]);
    setForm(order);
    setRecognized(allRecognized);
    setNotice(
      allRecognized.length > 0
        ? `Odczytano: ${allRecognized.join(", ")}. Sprawdź pola przed zapisem.`
        : "Nie udało się odczytać dokumentu automatycznie — wpisz pola ręcznie poniżej. Zapis działa tak samo jak przy imporcie."
    );
    setWarnings((prev) => [...prev, ...newWarnings]);
    setStage("review");
  }

  // Ręczne wpisanie zlecenia bez żadnego dokumentu — właściciel wprost o to poprosił: dyspozytor
  // musi móc wbić zlecenie z telefonu/maila, nie tylko z PDF-a. Ten sam formularz i ten sam zapis;
  // dokument (jeśli w ogóle będzie) da się dopiąć później przyciskiem "Dopnij PDF" przy wierszu.
  function startManual() {
    setNotice("Ręczne wpisywanie zlecenia — wypełnij pola i zapisz. Dokument PDF możesz dopiąć później.");
    setStage("review");
  }

  // "Tak, to to samo zlecenie" — dyspozytor potwierdza słabsze skojarzenie (kontener albo numer o
  // sprzecznych sygnałach). Od tej chwili zapis zachowuje się jak przy rozpoznaniu po numerze:
  // uzupełnia istniejący rekord, a wartości już w nim zapisane wygrywają z dokumentem.
  function adoptSuggestion(match: LoadMatch<Load>) {
    const found = match.load;
    setMatchedLoad(found);
    setSuggested(null);
    setForceNew(false);
    setSaveError(null);
    setForm((prev) => mergeParsedOrders(loadToForm(found), prev));
    if (found.contractor_id) setContractorId(found.contractor_id);
    if (found.carrier_name) setCarrierName(found.carrier_name);
  }

  function updateField<K extends keyof ParsedOrder>(key: K, value: ParsedOrder[K]) {
    setForm((prev) => {
      const next = withRecomputedGross({ ...prev, [key]: value }, key);
      // Reguła właściciela: uwagi ze słowem "Leasing" przestawiają gestię na "Leasing" — także gdy
      // dyspozytor dopisze to ręcznie w tym formularzu, nie tylko przy odczycie dokumentu.
      return key === "notes" ? withLeasingShippingLine(next) : next;
    });
  }

  function selectContractor(id: string) {
    setContractorId(id);
    const contractor = contractors.find((c) => c.id === id);
    if (contractor) setForm((prev) => applyContractorDefaults(prev, contractor));
  }

  function selectDriver(name: string) {
    const driver = fleet.drivers.find((d) => d.name === name);
    setForm((prev) => ({
      ...prev,
      driver_name: name,
      driver_id_number: driver?.docNumber || prev.driver_id_number,
    }));
  }

  function selectTractor(plate: string) {
    const tractor = fleet.tractors.find((v) => v.plate === plate);
    setForm((prev) => ({
      ...prev,
      vehicle_plate: plate,
      trailer_plate: prev.trailer_plate || tractor?.assignedTrailerPlate || "",
    }));
  }

  // Pierwsze zlecenie od nowego spedytora zakłada kontrahenta z danych z dokumentu (nazwa, NIP,
  // adres, termin płatności) i nazwą z dokumentu jako aliasem — kolejne zlecenia dopasują się same.
  // Sprawdzamy jeszcze raz po nazwie (lista mogła się zmienić od parsowania), żeby nie dublować.
  async function ensureContractor(): Promise<{ id: string; created: boolean } | { error: string }> {
    if (contractorId) return { id: contractorId, created: false };
    if (!form.forwarder) return { id: "", created: false };
    const existing = findContractorByName(contractors, form.forwarder);
    if (existing) return { id: existing.id, created: false };
    const { data, error } = await supabase
      .from("contractors")
      .insert({
        name: form.forwarder,
        aliases: [form.forwarder],
        nip: form.forwarder_nip || null,
        address: form.forwarder_address || null,
        postal_code: form.forwarder_postal_code || null,
        city: form.forwarder_city || null,
        payment_terms_days: form.payment_terms_days,
        payment_terms_note: form.payment_terms_note || null,
      })
      .select("id")
      .single();
    if (error) return { error: error.message };
    return { id: data.id as string, created: true };
  }

  async function handleSave() {
    if (form.direction !== "I" && form.direction !== "E") return;
    setStage("saving");
    setSaveError(null);

    // Ostatnia straż przed duplikatem: numer mógł zostać wpisany/poprawiony ręcznie PO odczycie
    // dokumentów, a numer zlecenia jest u klienta unikalny. Nie zapisujemy wtedy po cichu drugiego
    // rekordu — pokazujemy, do czego to pasuje, i zostawiamy decyzję dyspozytorowi.
    const target = existingLoad ?? matchedLoad;
    if (!target && !forceNew) {
      const match = matchExistingLoad(recentLoads, {
        order_number: form.order_number,
        container_number: form.container_number,
      });
      if (match?.auto) {
        setMatchedLoad(match.load);
        setForm((prev) => mergeParsedOrders(loadToForm(match.load), prev));
        setSaveError(
          `Zlecenie ${match.load.order_number ?? ""} już istnieje (${match.reason}). Zapis uzupełni je o brakujące pola — kliknij „Zapisz” jeszcze raz, albo „Utwórz mimo to nowe zlecenie”, jeśli to inne zlecenie.`
        );
        setStage("review");
        return;
      }
      // Słabsze skojarzenie nie blokuje zapisu — ten sam kontener na nowym zleceniu to normalna
      // sytuacja. Zatrzymujemy się TYLKO raz, żeby dyspozytor je zobaczył, zanim powstanie rekord.
      if (match && !dismissedMatches.includes(match.load.id)) {
        setSuggested(match);
        setDismissedMatches((prev) => [...prev, match.load.id]);
        setSaveError(
          `Zanim zapiszę: ${match.reason}. Jeśli to to samo zlecenie, kliknij „Uzupełnij zlecenie ${match.load.order_number ?? ""}” wyżej — jeśli nie, kliknij „Zapisz” jeszcze raz.`
        );
        setStage("review");
        return;
      }
    }

    const ensured = await ensureContractor();
    if ("error" in ensured) {
      setSaveError(`nie udało się założyć kontrahenta: ${ensured.error}`);
      setStage("review");
      return;
    }
    if (ensured.id && ensured.id !== contractorId) setContractorId(ensured.id);

    const row = formToRow(form, carrierName, ensured.id);
    let loadId = target?.id ?? "";
    if (target) {
      const { error } = await supabase.from("loads").update(row).eq("id", target.id);
      if (error) {
        setSaveError(error.message);
        setStage("review");
        return;
      }
    } else {
      const { data, error } = await supabase.from("loads").insert(row).select("id").single();
      if (error || !data) {
        setSaveError(error?.message ?? "Nie udało się zapisać zlecenia.");
        setStage("review");
        return;
      }
      loadId = data.id as string;
    }

    // Oryginały PDF idą do Storage DOPIERO teraz — wcześniej nie ma id zlecenia, do którego można
    // je podpiąć. Nieudane wgranie NIE cofa zapisu zlecenia (dane są ważniejsze niż plik), ale
    // musi być widoczne, a nie zjedzone po cichu.
    const failedUploads: string[] = [];
    for (const attachment of attachments) {
      setProgress(`Zapisywanie dokumentu ${attachment.file.name}…`);
      const error = await uploadDocument({
        loadId,
        file: attachment.file,
        kind: attachment.kind,
        parseSource: attachment.parseSource,
      });
      if (error) failedUploads.push(`${attachment.file.name}: ${error}`);
    }
    setProgress("");
    if (failedUploads.length > 0) {
      setAttachments([]);
      setSaveError(`Zlecenie zapisane, ale nie udało się dopiąć dokumentów: ${failedUploads.join("; ")}. Dodaj je przyciskiem „Dokumenty” przy wierszu.`);
      setStage("review");
      return;
    }

    // AUTO-NAUKA — dopiero tutaj, bo dopiero teraz wiadomo, co dyspozytor ZATWIERDZIŁ. To jest cała
    // różnica wobec uczenia się z odpowiedzi modelu: appka dopasowuje do tekstu dokumentu wartości
    // sprawdzone przez człowieka, a nie to, co model zgadł. Nauka nigdy nie blokuje zapisu — gdyby
    // padła, zlecenie i tak jest zapisane.
    const notes = await learnFromDocuments(learningDocs, form);
    if (notes.length > 0) onLearned?.(notes);

    // Dopiero po UDANYM zapisie — mail w Skrzynce ma zostać do przejrzenia, jeśli zapis padł.
    await onSaved?.(loadId);
    onClose();
  }

  const pickupOptions = withCurrentOption([...PICKUP_LOCATIONS], form.pickup_type);
  const driverOptions = withCurrentOption(fleet.drivers.map((d) => d.name), form.driver_name);
  const tractorOptions = withCurrentOption(fleet.tractors.map((v) => v.plate), form.vehicle_plate);
  const trailerOptions = withCurrentOption(fleet.trailers.map((v) => v.plate), form.trailer_plate);

  const title =
    mode === "attach"
      ? `Dopnij dokument do zlecenia ${existingLoad?.order_number ?? ""}`
      : mode === "edit"
        ? "Edytuj zlecenie"
        : "Nowe zlecenie (PDF albo ręcznie)";

  // Przy EKSPORCIE u klienta ŁADUJEMY (kontener jedzie w drugą stronę), a kontener zdajemy do portu
  // PEŁNY — te same kolumny bazy, ale etykiety "rozładunek"/"złożenie pustego" są wtedy mylące
  // (zgłoszenie właściciela po pierwszym zleceniu eksportowym). Kierunek zmienia więc same podpisy,
  // nie pola.
  // Rozbicie stawki na bazę i BAF pokazujemy pod polami OD RAZU (nie dopiero na fakturze) —
  // właściciel ma zobaczyć, ile z uzgodnionej kwoty to fracht, a ile dodatek paliwowy.
  const bafDescription = describeBafSplit(
    splitBaf(form.rate_amount, form.baf_percentage, form.rate_includes_baf === true),
    form.baf_percentage
  );

  const isExport = form.direction === "E";
  const stopLabel = isExport ? "załadunek" : "rozładunek";
  const stopGenitive = isExport ? "załadunku" : "rozładunku";
  const handoverLabel = isExport
    ? "Miejsce zdania kontenera (pełny)"
    : "Miejsce złożenia pustego";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            aria-label="Zamknij"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {stage === "pick" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <p className="max-w-xl text-center text-sm text-zinc-600 dark:text-zinc-400">
                {mode === "attach"
                  ? "Wybierz brakujący dokument (np. list przewozowy) — wypełni tylko puste pola tego zlecenia."
                  : "Wgraj PDF-y zlecenia — zlecenie spedycyjne i/lub list przewozowy dla kierowcy (można zaznaczyć oba naraz). Pola wyciągniemy automatycznie: znany szablon spedytora, a jeśli nieznany — odczyt przez Claude."}
              </p>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  handleFiles(e.dataTransfer.files);
                }}
                className={`flex w-full flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 transition-colors ${
                  dragging
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                    : "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900"
                }`}
              >
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                >
                  Wybierz pliki PDF
                </button>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">albo przeciągnij je tutaj</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  multiple
                  onChange={(e) => handleFiles(e.target.files)}
                  className="hidden"
                />
              </div>

              {mode !== "attach" && (
                <button
                  type="button"
                  onClick={startManual}
                  className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Wpisz zlecenie ręcznie (bez PDF-a)
                </button>
              )}
            </div>
          )}

          {stage === "parsing" && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-zinc-500">
              <span>{progress || "Odczytywanie dokumentów…"}</span>
              <span className="text-xs">Nic nie zapisuje się samo — pola pokażemy do sprawdzenia.</span>
            </div>
          )}

          {(stage === "review" || stage === "saving") && (
            <div className="flex flex-col gap-3">
              {notice && (
                <p className="rounded border border-blue-300 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
                  {notice}
                </p>
              )}
              {warnings.map((warning) => (
                <p
                  key={warning}
                  className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                >
                  {warning}
                </p>
              ))}
              {saveError && (
                <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                  Nie udało się zapisać: {saveError}
                </p>
              )}
              {matchedLoad && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  <span>
                    Rozpoznane zlecenie <strong>{matchedLoad.order_number ?? ""}</strong> — zapis uzupełni w nim brakujące
                    pola i dopnie dokumenty. Wartości już zapisane zostają bez zmian.
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setMatchedLoad(null);
                      setForceNew(true);
                      setSaveError(null);
                    }}
                    className="rounded border border-emerald-400 px-2 py-1 font-medium hover:bg-emerald-100 dark:border-emerald-700 dark:hover:bg-emerald-900"
                  >
                    Utwórz mimo to nowe zlecenie
                  </button>
                </div>
              )}
              {suggested && !matchedLoad && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
                  <span>
                    Możliwe, że to zlecenie <strong>{suggested.load.order_number ?? "(bez numeru)"}</strong> —{" "}
                    {suggested.reason}. Sam tego nie scalam: potwierdź, jeśli to ten sam ładunek.
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => adoptSuggestion(suggested)}
                      className="rounded border border-sky-400 px-2 py-1 font-medium hover:bg-sky-100 dark:border-sky-700 dark:hover:bg-sky-900"
                    >
                      Uzupełnij zlecenie {suggested.load.order_number ?? ""}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDismissedMatches((prev) => [...prev, suggested.load.id]);
                        setSuggested(null);
                        setSaveError(null);
                      }}
                      className="rounded border border-sky-400 px-2 py-1 font-medium hover:bg-sky-100 dark:border-sky-700 dark:hover:bg-sky-900"
                    >
                      To inne zlecenie
                    </button>
                  </span>
                </div>
              )}

              {attachments.length > 0 && (
                <div className="rounded border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
                  <div className="mb-1 font-medium text-zinc-700 dark:text-zinc-300">
                    Dokumenty do zapisania przy zleceniu ({attachments.length})
                  </div>
                  <ul className="flex flex-col gap-1">
                    {attachments.map((attachment, index) => (
                      <li key={`${attachment.file.name}-${index}`} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">
                          {attachment.file.name}
                          {attachment.parseSource ? "" : " (nieodczytany — zostanie zachowany)"}
                        </span>
                        <select
                          value={attachment.kind}
                          onChange={(e) =>
                            setAttachments((prev) =>
                              prev.map((a, i) => (i === index ? { ...a, kind: e.target.value as DocumentKind } : a))
                            )
                          }
                          className="rounded border border-zinc-300 px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        >
                          {DOCUMENT_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {DOCUMENT_KIND_LABELS[k]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                          className="text-zinc-400 hover:text-red-600"
                          aria-label={`Nie zapisuj dokumentu ${attachment.file.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                <span>Sprawdź i popraw pola przed zapisem — appka niczego nie zapisuje bez Twojej zgody.</span>
                <label className="cursor-pointer rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
                  + Dopnij kolejny dokument (PDF)
                  <input
                    type="file"
                    accept="application/pdf"
                    multiple
                    onChange={(e) => handleFiles(e.target.files)}
                    className="hidden"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Numer zlecenia">
                  <input className={inputClass} value={form.order_number} onChange={(e) => updateField("order_number", e.target.value)} />
                </Field>
                <Field label="Spedycja (zleceniodawca)">
                  <input className={inputClass} value={form.forwarder} onChange={(e) => updateField("forwarder", e.target.value)} />
                </Field>

                <Field label="Kontrahent (dane do faktury)" full>
                  <select className={inputClass} value={contractorId} onChange={(e) => selectContractor(e.target.value)}>
                    <option value="">— brak / dodaj w „Kontrahenci” —</option>
                    {contractors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.nip ? ` · NIP ${c.nip}` : ""}
                        {c.payment_terms_days !== null ? ` · ${c.payment_terms_days} dni` : ""}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Kierunek *">
                  <select className={inputClass} value={form.direction} onChange={(e) => updateField("direction", e.target.value as ParsedOrder["direction"])}>
                    <option value="">— wybierz —</option>
                    <option value="I">Import</option>
                    <option value="E">Eksport</option>
                  </select>
                </Field>
                <Field label="Podjęcie (terminal)">
                  <select className={inputClass} value={form.pickup_type} onChange={(e) => updateField("pickup_type", e.target.value)}>
                    <option value="">— wybierz —</option>
                    {pickupOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>

                <Field label="Numer kontenera">
                  <input className={inputClass} value={form.container_number} onChange={(e) => updateField("container_number", e.target.value)} />
                </Field>
                <Field label="PIN / booking">
                  <input className={inputClass} value={form.pin_booking} onChange={(e) => updateField("pin_booking", e.target.value)} />
                </Field>

                <Field label="Nr plomby">
                  <input className={inputClass} value={form.seal_number} onChange={(e) => updateField("seal_number", e.target.value)} />
                </Field>
                <Field label="Data złożenia (cut off)">
                  <input
                    className={inputClass}
                    value={form.submitted_when}
                    onChange={(e) => updateField("submitted_when", e.target.value)}
                    placeholder="np. 2026-09-12 albo „cut off 12.09, 14:00”"
                  />
                </Field>

                <Field label="Wielkość kontenera">
                  <input className={inputClass} value={form.container_size} onChange={(e) => updateField("container_size", e.target.value)} placeholder="np. 20DV" />
                </Field>
                <Field label="Gestia / linia">
                  <input className={inputClass} value={form.shipping_line} onChange={(e) => updateField("shipping_line", e.target.value)} placeholder="np. ONE" />
                </Field>

                <Field label={`Firma (${stopLabel})`}>
                  <input className={inputClass} value={form.company_name} onChange={(e) => updateField("company_name", e.target.value)} />
                </Field>
                <Field label="Miejscowość">
                  <input className={inputClass} value={form.city} onChange={(e) => updateField("city", e.target.value)} />
                </Field>

                <Field label="Adres" full>
                  <input className={inputClass} value={form.address} onChange={(e) => updateField("address", e.target.value)} />
                </Field>

                <Field label={`Data (domyślnie dzień roboczy przed ${isExport ? "załadunkiem" : "rozładunkiem"})`}>
                  <input type="date" className={inputClass} value={form.load_date} onChange={(e) => updateField("load_date", e.target.value)} />
                </Field>
                <Field label={`Data ${stopGenitive}`}>
                  <input type="date" className={inputClass} value={form.delivery_date} onChange={(e) => updateField("delivery_date", e.target.value)} />
                </Field>

                <Field label={`Godzina ${stopGenitive}`}>
                  <input className={inputClass} value={form.delivery_time} onChange={(e) => updateField("delivery_time", e.target.value)} placeholder="np. 07:00" />
                </Field>
                <Field label="Miejsce/status odprawy celnej">
                  <input className={inputClass} value={form.customs_location_or_status} onChange={(e) => updateField("customs_location_or_status", e.target.value)} />
                </Field>

                <Field label="Nazwa towaru" full>
                  <input className={inputClass} value={form.goods_name} onChange={(e) => updateField("goods_name", e.target.value)} />
                </Field>
                <Field label="Waga netto — towar (kg)">
                  <input
                    type="number"
                    step="any"
                    className={inputClass}
                    value={form.net_weight_kg ?? ""}
                    onChange={(e) => updateField("net_weight_kg", e.target.value === "" ? null : Number(e.target.value))}
                  />
                </Field>
                <Field label="Waga brutto (towar + tara kontenera)">
                  <input className={inputClass} value={form.gross_weight} onChange={(e) => updateField("gross_weight", e.target.value)} placeholder="liczone z typu kontenera" />
                </Field>

                <Field label={handoverLabel} full>
                  <input
                    className={inputClass}
                    value={form.submitted_where}
                    onChange={(e) => updateField("submitted_where", e.target.value)}
                    placeholder="terminal albo instrukcja z dokumentu (np. „zgodnie z instrukcjami armatora”)"
                  />
                </Field>

                <Field label="Kierowca (z Panelu floty)">
                  <select className={inputClass} value={form.driver_name} onChange={(e) => selectDriver(e.target.value)}>
                    <option value="">—</option>
                    {driverOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Nr dowodu kierowcy">
                  <input className={inputClass} value={form.driver_id_number} onChange={(e) => updateField("driver_id_number", e.target.value)} />
                </Field>

                <Field label="Pojazd (ciągnik, z Panelu floty)">
                  <select className={inputClass} value={form.vehicle_plate} onChange={(e) => selectTractor(e.target.value)}>
                    <option value="">—</option>
                    {tractorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Naczepa (z Panelu floty)">
                  <select className={inputClass} value={form.trailer_plate} onChange={(e) => updateField("trailer_plate", e.target.value)}>
                    <option value="">—</option>
                    {trailerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>

                <Field label="Telefon kierowcy">
                  <input className={inputClass} value={form.driver_phone} onChange={(e) => updateField("driver_phone", e.target.value)} />
                </Field>
                <Field label="Przewoźnik">
                  <input className={inputClass} value={carrierName} onChange={(e) => setCarrierName(e.target.value)} />
                </Field>

                <Field label="Stawka (PLN)">
                  <input type="number" step="0.01" className={inputClass} value={form.rate_amount ?? ""} onChange={(e) => updateField("rate_amount", e.target.value === "" ? null : Number(e.target.value))} />
                </Field>
                <Field label="Termin płatności (dni)">
                  <input type="number" className={inputClass} value={form.payment_terms_days ?? ""} onChange={(e) => updateField("payment_terms_days", e.target.value === "" ? null : Number(e.target.value))} />
                </Field>

                <Field label="BAF (dodatek paliwowy) — %">
                  <input
                    type="number"
                    step="0.01"
                    className={inputClass}
                    value={form.baf_percentage ?? ""}
                    onChange={(e) => updateField("baf_percentage", e.target.value === "" ? null : Number(e.target.value))}
                    placeholder="np. 13"
                  />
                </Field>
                <Field label="Czy stawka wyżej zawiera już BAF?">
                  <select
                    className={inputClass}
                    value={form.rate_includes_baf === true ? "included" : form.rate_includes_baf === false ? "added" : ""}
                    onChange={(e) => updateField("rate_includes_baf", e.target.value === "" ? null : e.target.value === "included")}
                  >
                    <option value="">— dokument nie mówi (liczymy jako doliczany) —</option>
                    <option value="included">Tak — stawka jest z BAF-em</option>
                    <option value="added">Nie — BAF dolicza się do stawki</option>
                  </select>
                </Field>

                {bafDescription && (
                  <p className="col-span-2 -mt-1 rounded bg-zinc-100 px-3 py-1.5 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    {bafDescription}
                  </p>
                )}

                <Field label="Warunek płatności" full>
                  <input className={inputClass} value={form.payment_terms_note} onChange={(e) => updateField("payment_terms_note", e.target.value)} placeholder="np. od wpływu faktury" />
                </Field>

                <Field label="Uwagi" full>
                  <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => updateField("notes", e.target.value)} />
                </Field>
              </div>
            </div>
          )}
        </div>

        {(stage === "review" || stage === "saving") && (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <button type="button" onClick={onClose} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
              Anuluj
            </button>
            <button
              type="button"
              disabled={stage === "saving" || (form.direction !== "I" && form.direction !== "E")}
              onClick={handleSave}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {stage === "saving"
                ? progress || "Zapisywanie…"
                : existingLoad || matchedLoad
                  ? `Uzupełnij zlecenie ${(existingLoad ?? matchedLoad)?.order_number ?? ""}`.trim()
                  : "Zapisz zlecenie"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// "Jeżeli w uwagach będzie Leasing, to wtedy gestia przestaw na Leasing" — reguła po stronie appki,
// więc działa niezależnie od tego, skąd wzięły się uwagi (szablon, Claude, mail, ręczne wpisanie).
function withLeasingShippingLine(order: ParsedOrder): ParsedOrder {
  const line = shippingLineForNotes(order.notes, order.shipping_line) ?? "";
  return line === order.shipping_line ? order : { ...order, shipping_line: line };
}

// Zmiana wagi towaru albo typu kontenera przelicza brutto (towar + tara). Ręcznie wpisany tekst w
// brutto (np. "według armatora") nie jest nadpisywany.
function withRecomputedGross(order: ParsedOrder, changedKey: keyof ParsedOrder): ParsedOrder {
  if (changedKey !== "net_weight_kg" && changedKey !== "container_size") return order;
  const gross = computeGrossWeightKg(order.net_weight_kg, order.container_size);
  if (gross === null || !canOverwriteGrossWeight(order.gross_weight)) return order;
  return { ...order, gross_weight: String(gross) };
}

// Domyślny termin płatności kontrahenta wchodzi tylko w PUSTE pola — jeśli dokument (albo
// dyspozytor) podał własny termin, ten z dokumentu wygrywa; rozbieżność tylko sygnalizujemy.
function applyContractorDefaults(order: ParsedOrder, contractor: Contractor, warnings?: string[]): ParsedOrder {
  const next = { ...order };
  if (next.payment_terms_days === null && contractor.payment_terms_days !== null) {
    next.payment_terms_days = contractor.payment_terms_days;
    if (!next.payment_terms_note && contractor.payment_terms_note) next.payment_terms_note = contractor.payment_terms_note;
  } else if (
    warnings &&
    next.payment_terms_days !== null &&
    contractor.payment_terms_days !== null &&
    next.payment_terms_days !== contractor.payment_terms_days
  ) {
    warnings.push(`Termin płatności z dokumentu (${next.payment_terms_days} dni) różni się od ustawionego dla kontrahenta ${contractor.name} (${contractor.payment_terms_days} dni) — zostawiono wartość z dokumentu.`);
  }
  return next;
}

const inputClass =
  "w-full rounded border border-zinc-300 px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-0.5 text-xs text-zinc-600 dark:text-zinc-400 ${full ? "col-span-2" : ""}`}>
      {label}
      {children}
    </label>
  );
}
