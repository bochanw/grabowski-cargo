-- ============================================================
-- Zmiana zasady widoku: "daj każdemu wszystko i najwyżej będziemy sobie ręcznie wyłączać"
-- (właściciel, po pierwszym teście 0007). Domyślny widok w appce to od teraz KOMPLET kolumn, a
-- przełączniki bloków (Ładunek/Rozliczenie/Fakturowanie/Inne) zniknęły z paska.
--
-- Wiersze zapisane PRZED tą zmianą mają w `hidden` stary zestaw domyślny — 28 kolumn spoza bloku
-- "Ładunek" — który nikt świadomie nie wybrał: wpadał tam automatycznie przy pierwszym zapisie
-- (np. samym ustawieniem liczby zamrożonych kolumn). Zerujemy go, żeby po wdrożeniu każdy
-- faktycznie zobaczył wszystko.
--
-- Świadomie WĄSKO: ruszamy tylko wiersze, w których `hidden` to DOKŁADNIE tamten stary domyślny
-- zestaw. Czyjekolwiek własne ukrycia (inny zestaw kolumn) zostają nietknięte. Kolejność kolumn
-- i liczba zamrożonych zostają bez zmian w każdym przypadku.
-- ============================================================

update public.user_view_settings
set settings = jsonb_set(settings, '{hidden}', '[]'::jsonb)
where (
  select array_agg(value order by value)
  from jsonb_array_elements_text(settings->'hidden')
) = array[
  'adr_flag','baf_amount','baf_percentage','carrier_name','contractor_id','correct_data_flag',
  'delivery_or_customs','documents_received_date','gct_invoice_number','gct_leasing_addons',
  'invoice_amount','invoice_code','invoice_issued_at','invoice_number','invoice_payment_date',
  'loading_number','payment_terms_days','payment_terms_note','rate_misc','rebilling_comment',
  'settled_weight_kg','subcontractor_invoice_number','subcontractor_net_amount','subcontractor_paid',
  'subcontractor_payment_due_date','subcontractor_rate','total_amount','wants_own_cmr'
]::text[];
