-- ============================================================
-- Poprawka do 0008 (ta migracja robi to, co 0008 miało zrobić — 0008 zostaje w historii jako
-- ślad, że przeszła bez efektu).
--
-- PUŁAPKA: 0008 porównywało `array_agg(value order by value)` z ręcznie posortowaną tablicą.
-- `order by` na tekście używa collation bazy (en_US.UTF-8), które przy porównywaniu POMIJA
-- podkreślenia — więc "subcontractor_invoice_number" i "subcontractor_net_amount" ustawiają się
-- inaczej niż w sortowaniu ASCII, tablice wychodzą różne i `update` nie łapie żadnego wiersza.
-- Tu porównujemy ZBIORY przez zawieranie jsonb w obie strony (`@>` i `<@`) — kolejność elementów
-- i collation przestają mieć znaczenie.
-- Na przyszłość: nie porównywać list kluczy przez sortowanie tekstu, tylko przez zawieranie.
--
-- Cel bez zmian: wyzerować `hidden` TYLKO tam, gdzie jest to stary zestaw domyślny (28 kolumn
-- spoza bloku "Ładunek"), którego nikt świadomie nie wybrał. Czyjeś własne ukrycia zostają.
-- ============================================================

update public.user_view_settings
set settings = jsonb_set(settings, '{hidden}', '[]'::jsonb)
where settings->'hidden' @> '["adr_flag","baf_amount","baf_percentage","carrier_name","contractor_id","correct_data_flag","delivery_or_customs","documents_received_date","gct_invoice_number","gct_leasing_addons","invoice_amount","invoice_code","invoice_issued_at","invoice_number","invoice_payment_date","loading_number","payment_terms_days","payment_terms_note","rate_misc","rebilling_comment","settled_weight_kg","subcontractor_invoice_number","subcontractor_net_amount","subcontractor_paid","subcontractor_payment_due_date","subcontractor_rate","total_amount","wants_own_cmr"]'::jsonb
  and settings->'hidden' <@ '["adr_flag","baf_amount","baf_percentage","carrier_name","contractor_id","correct_data_flag","delivery_or_customs","documents_received_date","gct_invoice_number","gct_leasing_addons","invoice_amount","invoice_code","invoice_issued_at","invoice_number","invoice_payment_date","loading_number","payment_terms_days","payment_terms_note","rate_misc","rebilling_comment","settled_weight_kg","subcontractor_invoice_number","subcontractor_net_amount","subcontractor_paid","subcontractor_payment_due_date","subcontractor_rate","total_amount","wants_own_cmr"]'::jsonb;
