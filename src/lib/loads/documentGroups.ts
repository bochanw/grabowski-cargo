// KILKA DOKUMENTÓW = ILE ZLECEŃ? (właściciel: „czasami mail nie ma załączników, a czasami jest ich
// kilka (kilka zleceń)").
//
// Dotąd appka zakładała, że wszystkie wgrane naraz dokumenty opisują JEDNO zlecenie — bo tak jest
// u Q4Road (zlecenie spedycyjne + list przewozowy dla kierowcy). Przy mailu z kilkoma zleceniami to
// założenie jest groźne: scalenie „tylko puste pola" zlepiłoby dwa różne ładunki w jeden rekord,
// z numerem pierwszego i stawką pierwszego, a drugie zlecenie zniknęłoby bez śladu.
//
// Rozstrzyga NUMER ZLECENIA — to samo kryterium, którym appka rozpoznaje zlecenie już zapisane
// (src/lib/loads/orderNumber.ts): porównanie na formie znormalizowanej, a gdy dokumenty składają
// człony inaczej ("KPB / 87" vs "87 / KPB") — na kluczu z posortowanych członów.
//
// Dokument BEZ numeru (typowy list przewozowy, skan, którego nie udało się odczytać) dołącza do
// jedynej grupy, jaka jest — bo to właśnie przypadek Q4Road. Gdy grup jest więcej, appka NIE
// ZGADUJE, do którego zlecenia należy: robi z niego osobną pozycję i mówi o tym wprost. Zgadnięcie
// znaczyłoby dopięcie dokumentu do cudzego zlecenia, a tego z Zestawienia już nie widać.

import { mergeParsedOrders, type ParsedOrder } from "@/types/parsedOrder";
import { normalizeOrderNumber, orderNumberLooseKey } from "./orderNumber";

export interface ParsedDocument<T> {
  /** Pola odczytane z tego JEDNEGO dokumentu (pusty ParsedOrder, gdy nic nie odczytano). */
  parsed: ParsedOrder;
  fileName: string;
  /** Cokolwiek wołający niesie razem z dokumentem: plik do wgrania, materiał do nauki, id załącznika. */
  payload: T;
}

export interface DocumentGroup<T> {
  /** Pola wszystkich dokumentów tej grupy sklejone regułą „tylko puste pola". */
  parsed: ParsedOrder;
  documents: ParsedDocument<T>[];
  /** Numer, po którym grupa się zebrała — pusty, gdy żaden dokument go nie podał. */
  orderNumber: string;
  /** Dokumenty bez numeru, których nie dało się jednoznacznie przypisać (grup było więcej niż jedna). */
  unmatched: boolean;
}

function sameOrder(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normalizeOrderNumber(a) === normalizeOrderNumber(b)) return true;
  const keyA = orderNumberLooseKey(a);
  return Boolean(keyA) && keyA === orderNumberLooseKey(b);
}

export function groupDocumentsByOrder<T>(documents: ParsedDocument<T>[]): DocumentGroup<T>[] {
  const groups: DocumentGroup<T>[] = [];

  const dodaj = (group: DocumentGroup<T>, document: ParsedDocument<T>) => {
    group.documents.push(document);
    group.parsed = mergeParsedOrders(group.parsed, document.parsed);
    if (!group.orderNumber && document.parsed.order_number) group.orderNumber = document.parsed.order_number;
  };

  for (const document of documents) {
    const numer = document.parsed.order_number;

    if (numer) {
      const existing = groups.find((group) => sameOrder(group.orderNumber, numer));
      if (existing) {
        dodaj(existing, document);
        continue;
      }
      // Dokument z numerem może też domknąć grupę, która numeru jeszcze nie miała (np. wgrany
      // najpierw list przewozowy bez numeru, potem zlecenie) — ale tylko wtedy, gdy grupa jest jedna.
      const bezNumeru = groups.filter((group) => !group.orderNumber);
      if (groups.length === 1 && bezNumeru.length === 1) {
        dodaj(bezNumeru[0], document);
        continue;
      }
      groups.push({ parsed: document.parsed, documents: [document], orderNumber: numer, unmatched: false });
      continue;
    }

    if (groups.length === 1) {
      dodaj(groups[0], document);
      continue;
    }
    if (groups.length === 0) {
      groups.push({ parsed: document.parsed, documents: [document], orderNumber: "", unmatched: false });
      continue;
    }
    // Grup jest kilka, a dokument nie mówi, do którego zlecenia należy — własna pozycja i jawne
    // ostrzeżenie. Wybranie „tej pierwszej" byłoby zgadywaniem, którego nie da się potem wychwycić.
    groups.push({ parsed: document.parsed, documents: [document], orderNumber: "", unmatched: true });
  }

  return groups;
}

/** Załącznik maila w kształcie, którego potrzebuje rozdzielanie (reszta kolumn jest tu nieistotna). */
export interface AttachmentLike {
  id: string;
  filename: string | null;
  parsed: ParsedOrder | null;
}

/**
 * ILE ZLECEŃ niesie jeden mail — i który załącznik należy do którego.
 *
 * Trzy sytuacje, wszystkie realne (właściciel: „czasami mail nie ma załączników, a czasami jest ich
 * kilka (kilka zleceń)"):
 *  • bez załączników → jedno zlecenie z pól odczytanych z treści maila;
 *  • załączniki bez własnego odczytu (starszy `mail-poll`, skan nie do odczytania) → jedno zlecenie
 *    z pól maila, ze WSZYSTKIMI załącznikami — czyli zachowanie sprzed rozdzielania;
 *  • załączniki z własnym odczytem → tyle zleceń, ile RÓŻNYCH numerów; każdy dokument idzie do
 *    swojego. Nieodczytane dokumenty dopinamy do pierwszego zlecenia, żeby oryginał nie został
 *    w skrzynce bez powiązania.
 */
export interface MailOrder {
  parsed: ParsedOrder;
  externalIds: string[];
  warnings: string[];
}

export function ordersFromAttachments(mailParsed: ParsedOrder | null, attachments: AttachmentLike[]): MailOrder[] {
  const odczytane = attachments.filter((a) => a.parsed);
  if (odczytane.length === 0) {
    return mailParsed ? [{ parsed: mailParsed, externalIds: attachments.map((a) => a.id), warnings: [] }] : [];
  }

  const groups = groupDocumentsByOrder(
    odczytane.map((a) => ({
      parsed: a.parsed as ParsedOrder,
      fileName: a.filename ?? "załącznik.pdf",
      payload: a.id,
    }))
  );
  const nieodczytane = attachments.filter((a) => !a.parsed).map((a) => a.id);

  // TREŚĆ MAILA niesie zwykle informację DO zlecenia („stawka +200", „przesuwamy na piątek"), a jej
  // odczyt siedzi w polach maila (`email_messages.parsed`) obok pól z dokumentów. Gdy mail dotyczy
  // JEDNEGO zlecenia, dokładamy je tutaj — dokument wygrywa, treść uzupełnia to, czego w nim nie ma.
  // Przy kilku zleceniach na jednym mailu tego nie robimy: pola maila są wtedy zlepkiem kilku
  // zleceń i przypisanie ich do któregokolwiek byłoby zgadywaniem — mówimy o tym wprost.
  const wielozleceniowy = groups.length > 1;
  return groups.map((group, index) => ({
    parsed: !wielozleceniowy && mailParsed ? mergeParsedOrders(group.parsed, mailParsed) : group.parsed,
    externalIds:
      index === 0 ? [...group.documents.map((d) => d.payload), ...nieodczytane] : group.documents.map((d) => d.payload),
    warnings: wielozleceniowy
      ? [
          'Ten mail niesie kilka zleceń, więc informacji z jego TREŚCI (np. zmiana terminu, dodatkowa stawka) appka nie przypisała automatycznie — sprawdź zakładkę „Treść maila” w podglądzie źródła obok.',
        ]
      : [],
  }));
}
