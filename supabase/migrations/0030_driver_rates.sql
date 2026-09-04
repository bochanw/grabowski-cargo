-- ============================================================
-- Migracja 0030 — STAWKI DLA KIEROWCÓW wg kodu pocztowego i tonażu.
--
-- Źródło: arkusz właściciela ("Zeszyt1.xlsx", Arkusz 1) — 283 wiersze,
-- kolumny: Kod / Miejscowość / do 15t / pow. 15t / pow. 22t.
--
-- Dlaczego `prefix` to SAME CYFRY (2 albo 3), a nie zapis z arkusza ("06-1"):
-- dopasowanie do kodu pocztowego zlecenia jest porównaniem PREFIKSU
-- ("80-299" → "80299" → próbuj "802", potem "80"), więc myślnik z arkusza
-- tylko przeszkadzałby. Zapis „06-1" odtwarza UI (src/lib/driverRates/rates.ts,
-- formatRatePrefix) — dyspozytor widzi cennik dokładnie tak jak w arkuszu.
--
-- Dlaczego tabela, a nie stała w kodzie: stawki się zmieniają (paliwo, nowa
-- umowa), a wtedy zmiana ma być kliknięciem w appce, nie wdrożeniem. To samo
-- rozstrzygnięcie, co przy `contractors` i `order_templates`.
-- ============================================================

create table if not exists public.driver_rates (
  -- Prefiks kodu pocztowego: 2 cyfry ("06" = całe 06-xxx) albo 3 ("061" = 06-1xx).
  -- Bardziej szczegółowy wygrywa — patrz findRateRow() w src/lib/driverRates/rates.ts.
  prefix         text primary key check (prefix ~ '^[0-9]{2,3}$'),
  -- Miejscowość jest INFORMACYJNA (właściciel: "miejscowość możesz generalnie pominąć albo pobrać
  -- informacyjnie") — appka używa jej tylko jako ostatniej deski ratunku, gdy zlecenie nie ma kodu
  -- pocztowego, i to wyłącznie wtedy, gdy wszystkie pasujące wiersze mają IDENTYCZNE stawki.
  city           text,
  rate_to_15t    numeric not null,
  rate_over_15t  numeric not null,
  rate_over_22t  numeric not null,
  updated_at     timestamptz not null default now()
);

alter table public.driver_rates enable row level security;

drop policy if exists "wymaga logowania" on public.driver_rates;
create policy "wymaga logowania"
on public.driver_rates
as permissive
for all
to authenticated
using (true)
with check (true);

create or replace function public.set_driver_rates_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.set_driver_rates_updated_at() from anon, authenticated, public;

drop trigger if exists driver_rates_set_updated_at on public.driver_rates;
create trigger driver_rates_set_updated_at
before update on public.driver_rates
for each row execute function public.set_driver_rates_updated_at();

-- Cennik edytowany w appce ma się zmieniać u wszystkich naraz (dwóch dyspozytorów, jedna prawda).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'driver_rates'
  ) then
    alter publication supabase_realtime add table public.driver_rates;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- Kod pocztowy dostawy/załadunku przy zleceniu.
-- Do tej pory appka NIE MIAŁA gdzie go trzymać (adres to wolny tekst, a w danych
-- produkcyjnych nie było ani jednego kodu) — a to on decyduje o stawce.
-- ------------------------------------------------------------
alter table public.loads add column if not exists postal_code text;

-- ------------------------------------------------------------
-- "Stawka dla kierowcy" (kolumna Y arkusza) była TEXT-em w formacie "[500 zł]".
-- Do miesięcznego podsumowania trzeba liczby, więc kolumna zmienia TYP, a nie nazwę
-- (nazwa siedzi w activity_log i w zapisanych ustawieniach widoku każdego użytkownika).
-- Konwersja jest bezpieczna: sprawdzone zapytaniem, że na produkcji nie ma ani jednej
-- wypełnionej wartości; gdyby jednak była, wyciągamy z niej liczbę zamiast wywalać migrację.
-- ------------------------------------------------------------
alter table public.loads
  alter column driver_rate type numeric
  using nullif(regexp_replace(replace(coalesce(driver_rate, ''), ',', '.'), '[^0-9.]', '', 'g'), '')::numeric;

-- Który wiersz cennika dał tę stawkę — do dymka przy komórce i do wyjaśnienia
-- „skąd ta kwota" w miesięcznym zestawieniu.
alter table public.loads add column if not exists driver_rate_code text;

-- 'auto'  = wyliczona z cennika; wolno ją przeliczyć ponownie.
-- 'manual'= wpisana ręcznie przez dyspozytora; appka jej NIGDY sama nie nadpisuje
--           (także wtedy, gdy dyspozytor świadomie wyczyścił pole).
-- null    = stawki nie ma i nikt jej nie ustawiał.
alter table public.loads add column if not exists driver_rate_source text
  check (driver_rate_source in ('auto', 'manual'));

-- Miesięczne zestawienie stawek to zapytanie "zlecenia z tego miesiąca, per kierowca".
create index if not exists loads_load_date_driver_idx on public.loads (load_date, driver_name);

-- ------------------------------------------------------------
-- Cennik z arkusza właściciela. `on conflict do nothing`: ponowne odpalenie migracji
-- nie ma prawa cofnąć stawek poprawionych później w appce.
-- ------------------------------------------------------------
insert into public.driver_rates (prefix, city, rate_to_15t, rate_over_15t, rate_over_22t) values
  ('00', 'Warszawa', 300, 300, 350),
  ('01', 'Warszawa', 300, 300, 350),
  ('02', 'Warszawa', 300, 300, 350),
  ('03', 'Warszawa', 300, 300, 350),
  ('04', 'Warszawa', 300, 300, 350),
  ('05', 'Okolice Warszawy', 300, 300, 350),
  ('06', 'Mława/Przasnysz', 250, 250, 300),
  ('061', 'Pułtusk', 300, 300, 350),
  ('07', 'Wyszków/Ostrów Maz.', 300, 300, 350),
  ('074', 'Ostrołęka', 300, 300, 350),
  ('081', 'Siedlce', 350, 350, 400),
  ('082', 'Łosice', 350, 350, 400),
  ('083', 'Sokołów Podlaski', 350, 350, 400),
  ('084', 'Garwolin', 350, 350, 400),
  ('085', 'Ryki', 350, 350, 400),
  ('09', 'Płock', 300, 300, 350),
  ('10', 'Olsztyn', 250, 250, 300),
  ('110', 'Olsztynek/Dobre Miasto', 250, 250, 300),
  ('111', 'Lidzbark Warm/Orneta', 250, 250, 300),
  ('112', 'Bartoszyce', 250, 250, 300),
  ('113', 'Biskupiec', 250, 250, 300),
  ('114', 'Kętrzyn', 300, 300, 350),
  ('115', 'Giżycko', 300, 300, 350),
  ('116', 'Węgorzewo', 300, 300, 350),
  ('117', 'Mrągowo', 300, 300, 350),
  ('121', 'Szczytno', 300, 300, 350),
  ('122', 'Pisz', 300, 300, 350),
  ('131', 'Nidzica', 250, 250, 300),
  ('132', 'Działdowo', 250, 250, 300),
  ('133', 'Nowe Miasto Lubawskie', 250, 250, 300),
  ('14', 'Braniewo/Pasłęk/Iława', 250, 250, 300),
  ('15', 'Bialystok', 400, 450, 500),
  ('160', 'Do okoła Białegostoku', 400, 450, 500),
  ('161', 'Sokółka', 400, 450, 500),
  ('162', 'Dąbrowa Białostocka', 400, 450, 500),
  ('163', 'Augustów', 400, 450, 500),
  ('164', 'Suwałki', 400, 450, 500),
  ('165', 'Sejny', 450, 500, 550),
  ('17', 'Bielsk Podlaski', 400, 450, 500),
  ('18', 'Łomża', 300, 300, 350),
  ('181', 'Łapy', 400, 450, 500),
  ('182', 'Wysokie Mazowieckie', 350, 400, 450),
  ('183', 'Zambrów', 350, 400, 450),
  ('191', 'Mońki', 400, 450, 500),
  ('192', 'Grajewo', 350, 400, 450),
  ('193', 'Ełk', 350, 400, 450),
  ('194', 'Olecko', 400, 450, 500),
  ('195', 'Gołdap', 400, 450, 500),
  ('20', 'Lublin', 450, 500, 550),
  ('210', 'Łęczna/Piaski', 450, 500, 550),
  ('211', 'Lubartów', 450, 500, 550),
  ('212', 'Parczew', 450, 500, 550),
  ('213', 'Radzyń Podlaski', 400, 500, 550),
  ('214', 'Łuków', 350, 400, 450),
  ('215', 'Biała Podlaska', 400, 500, 550),
  ('221', 'Chełm', 500, 550, 600),
  ('222', 'Włodawa', 450, 500, 550),
  ('223', 'Krasnystaw', 500, 550, 600),
  ('224', 'Zamość', 500, 550, 600),
  ('225', 'Hrubieszów', 500, 550, 600),
  ('226', 'Tomaszów Lubelski', 500, 550, 600),
  ('231', 'Bychawa', 450, 500, 550),
  ('232', 'Kraśnik', 450, 500, 550),
  ('233', 'Janów Lubelski', 450, 500, 550),
  ('234', 'Biłgoaraj', 450, 500, 550),
  ('241', 'Puławy', 400, 450, 500),
  ('242', 'Bełżyce', 400, 500, 550),
  ('243', 'Opole Lubelskie', 400, 500, 550),
  ('25', 'Kielce', 400, 400, 450),
  ('260', 'Morawica/Daleszyce', 400, 400, 450),
  ('261', 'Skarżysko-Kamienna', 400, 400, 450),
  ('262', 'Końskie', 350, 400, 450),
  ('263', 'Opoczno', 350, 400, 450),
  ('264', 'Przysucha', 350, 400, 450),
  ('265', 'Szydłowiec', 350, 400, 450),
  ('266', 'Radom', 350, 400, 450),
  ('267', 'Zwoleń', 350, 400, 450),
  ('268', 'Białobrzegi', 350, 350, 400),
  ('269', 'Kozienice', 350, 400, 450),
  ('271', 'Iłża', 350, 400, 450),
  ('272', 'Starachowice', 350, 400, 450),
  ('273', 'Lipsko', 350, 400, 450),
  ('274', 'Ostrowiec Świętokrzyski', 400, 500, 550),
  ('275', 'Opatów', 400, 500, 550),
  ('276', 'Sandomierz', 400, 500, 550),
  ('281', 'Budko-Zdrój', 400, 500, 550),
  ('282', 'Staszów', 400, 500, 550),
  ('283', 'Jędrzejów', 400, 500, 550),
  ('284', 'Pinczów', 400, 500, 550),
  ('285', 'Kazimierza Wielka', 450, 500, 550),
  ('29', 'Włoszczowa', 350, 400, 450),
  ('30', 'Kraków', 450, 500, 550),
  ('31', 'Kraków', 450, 500, 550),
  ('320', 'Do okoła Krakowa', 450, 500, 550),
  ('321', 'Proszowice', 450, 500, 550),
  ('322', 'Miechów', 450, 500, 550),
  ('323', 'Olkusz', 450, 500, 550),
  ('324', 'Myślenice', 450, 500, 550),
  ('325', 'Alwernia', 450, 500, 550),
  ('326', 'Oświęcim', 450, 500, 550),
  ('327', 'Bochnia', 450, 500, 550),
  ('328', 'Brzesko', 450, 500, 550),
  ('33', 'Nowy Sącz', 500, 550, 600),
  ('341', 'Wadowice', 450, 500, 550),
  ('342', 'Sucha Beskidzka', 500, 550, 600),
  ('343', 'Żywiec', 500, 550, 600),
  ('344', 'Nowy Targ', 500, 550, 600),
  ('345', 'Zakopane', 550, 600, 650),
  ('346', 'Limanowa', 500, 550, 600),
  ('347', 'Rabka Zdrój', 500, 550, 600),
  ('35', 'Rzeszów', 500, 550, 600),
  ('360', 'Głogów Małopolski', 500, 550, 600),
  ('361', 'Kolbuszowa', 500, 550, 600),
  ('362', 'Brzozów', 500, 550, 600),
  ('371', 'Łańcut', 500, 550, 600),
  ('372', 'Przeworsk', 500, 550, 600),
  ('373', 'Leżajsk', 500, 550, 600),
  ('374', 'Stalowa Wola', 450, 500, 550),
  ('375', 'Jarosław/Radymno', 500, 550, 600),
  ('376', 'Lubaczów', 500, 550, 600),
  ('377', 'Przemyśl', 550, 600, 650),
  ('381', 'Strzyżów', 500, 550, 600),
  ('382', 'Jasło', 500, 550, 600),
  ('383', 'Gorlice', 500, 550, 600),
  ('384', 'Krosno', 500, 550, 600),
  ('385', 'Sanok', 550, 600, 650),
  ('386', 'Lesko', 550, 600, 650),
  ('387', 'Ustrzyki Dolne', 550, 600, 650),
  ('391', 'Ropczyce', 500, 600, 650),
  ('392', 'Dębica', 500, 550, 600),
  ('393', 'Mielec', 450, 500, 550),
  ('394', 'Tarnobrzeg', 450, 500, 550),
  ('40', 'Katowice', 400, 500, 550),
  ('41', 'Chorzów/Bytom', 400, 500, 550),
  ('42', 'Częstochowa i okolice', 350, 400, 450),
  ('424', 'Zawiecie i okolice', 400, 500, 550),
  ('425', 'Będzin', 400, 500, 550),
  ('426', 'Tarnowskie Góry', 400, 500, 550),
  ('431', 'Tychy', 400, 500, 550),
  ('432', 'Pszczyna', 450, 500, 550),
  ('433', 'Bielsko-Biała', 450, 500, 550),
  ('434', 'Skoczów', 450, 500, 550),
  ('435', 'Czechowice-Dziedzice', 450, 500, 550),
  ('436', 'Jaworzno', 400, 500, 550),
  ('441', 'Gliwice', 400, 500, 550),
  ('442', 'Rybnik', 450, 500, 550),
  ('443', 'Wodzisław Śl.', 450, 500, 550),
  ('45', 'Opole', 400, 500, 550),
  ('46', 'Kluczbork', 400, 500, 550),
  ('471', 'Strzelce Opolskie', 400, 500, 550),
  ('472', 'Kędzierzyn Koźle', 450, 500, 550),
  ('473', 'Krapkowice', 400, 500, 550),
  ('474', 'Racibórz', 450, 500, 550),
  ('481', 'Głubczyce/Kietrz', 450, 500, 550),
  ('482', 'Prudnik', 450, 500, 550),
  ('483', 'Nysa', 450, 500, 550),
  ('49', 'Niemodlin/Tułowice/Brzeg', 400, 500, 550),
  ('50', 'Wrocław', 400, 500, 550),
  ('51', 'Wrocław', 400, 500, 550),
  ('52', 'Wrocław', 400, 500, 550),
  ('53', 'Wrocław', 400, 500, 550),
  ('54', 'Wrocław', 400, 500, 550),
  ('55', 'Kąty Wrocł./Oława', 400, 500, 550),
  ('56', 'Nad Wrocławiem', 400, 500, 550),
  ('561', 'Wołów', 400, 500, 550),
  ('562', 'Góra', 350, 400, 450),
  ('563', 'Milicz', 350, 400, 450),
  ('564', 'Oleśnica', 400, 500, 550),
  ('565', 'Syców', 400, 500, 550),
  ('571', 'Strzelin', 450, 500, 550),
  ('572', 'Ząbkowice Śl.', 450, 500, 550),
  ('573', 'Kłodzko', 500, 550, 600),
  ('574', 'Nowa Ruda', 450, 500, 550),
  ('575', 'Bystrzyca Kłodzka', 500, 550, 600),
  ('581', 'Świdnica', 450, 500, 550),
  ('582', 'Dzierżoniów', 450, 500, 550),
  ('583', 'Wałbrzych', 450, 500, 550),
  ('584', 'Kamienna Góra', 500, 550, 600),
  ('585', 'Jelenia Góra', 500, 550, 600),
  ('591', 'Polkowice', 400, 450, 500),
  ('592', 'Legnica', 400, 500, 550),
  ('593', 'Środa Śl.', 400, 500, 550),
  ('594', 'Jawor', 450, 500, 550),
  ('595', 'Złotoryja', 450, 500, 550),
  ('596', 'Lwówek Śl.', 450, 500, 550),
  ('597', 'Bolesławiec', 450, 500, 550),
  ('598', 'Lubań', 500, 550, 600),
  ('599', 'Zgorzelec', 500, 550, 600),
  ('60', 'Poznań', 300, 300, 350),
  ('61', 'Poznań/Mosina', 300, 300, 350),
  ('620', 'Okolice Poznania', 300, 300, 350),
  ('621', 'Wągrowiec', 300, 300, 350),
  ('622', 'Gniezno', 300, 300, 350),
  ('623', 'Września', 300, 300, 350),
  ('624', 'Słupca', 300, 300, 350),
  ('625', 'Konin', 300, 300, 350),
  ('626', 'Koło', 300, 300, 350),
  ('627', 'Turek', 300, 300, 350),
  ('628', 'Kalisz', 350, 350, 400),
  ('630', 'Środa Wlkp.', 300, 300, 350),
  ('631', 'Śrem', 300, 350, 400),
  ('632', 'Jarocin', 300, 350, 400),
  ('633', 'Pleszew', 300, 350, 400),
  ('634', 'Ostrów Wlkp.', 350, 400, 450),
  ('635', 'Ostrzeszów', 350, 400, 450),
  ('636', 'Kępno', 350, 400, 450),
  ('637', 'Krotoszyn', 350, 400, 450),
  ('638', 'Gostyń', 350, 400, 450),
  ('639', 'Miejska Górka', 350, 400, 450),
  ('640', 'Kościan', 300, 350, 400),
  ('641', 'Leszno', 350, 400, 450),
  ('642', 'Wolsztyn', 350, 350, 400),
  ('643', 'Nowy Tomyśl', 350, 350, 400),
  ('644', 'Międzychów', 300, 300, 350),
  ('645', 'Szamotuły', 300, 300, 350),
  ('646', 'Oborniki', 300, 300, 350),
  ('647', 'Krzyż Wlkp.', 300, 300, 350),
  ('648', 'Chodzież', 250, 250, 300),
  ('649', 'Piła', 250, 250, 300),
  ('65', 'Zielona Góra', 400, 450, 500),
  ('660', 'Okolice ZG', 400, 450, 500),
  ('661', 'Sulechów', 350, 350, 400),
  ('662', 'Swiebodziń', 350, 350, 400),
  ('663', 'Międzyrzecz', 350, 350, 400),
  ('664', 'Gorzów Wlkp.', 350, 400, 450),
  ('665', 'Dobiegniew', 300, 300, 350),
  ('666', 'Krosno Odrzańskie', 400, 500, 550),
  ('67', 'Nowa Sól', 400, 450, 500),
  ('674', 'Wschowa', 350, 400, 450),
  ('68', 'Żary', 400, 500, 550),
  ('69', 'Sulęcin', 400, 450, 500),
  ('70', 'Szczecin', 350, 400, 450),
  ('71', 'Szczecin', 350, 400, 450),
  ('720', 'Dołuje/Police', 350, 400, 450),
  ('721', 'Goleniów', 350, 400, 450),
  ('722', 'Nowogard', 350, 400, 450),
  ('723', 'Gryfice', 300, 350, 400),
  ('724', 'Kamień Pomorski', 350, 400, 450),
  ('725', 'Wolin', 350, 400, 450),
  ('726', 'Świnoujście', 350, 400, 450),
  ('73', 'Stargard', 350, 400, 450),
  ('74', 'Pod Szczecinem', 350, 400, 450),
  ('75', 'Koszalin', 250, 250, 300),
  ('76', 'Słupsk/Koszlalin okolice', 250, 250, 300),
  ('771', 'Bytów', 250, 250, 300),
  ('772', 'Miastko', 250, 250, 300),
  ('773', 'Człuchów', 250, 250, 300),
  ('774', 'Złotów', 250, 250, 300),
  ('781', 'Kołobrzeg', 250, 300, 350),
  ('782', 'Białogard', 250, 300, 350),
  ('783', 'Świdwin', 250, 300, 350),
  ('784', 'Szczecinek', 250, 250, 300),
  ('785', 'Złocieniec', 250, 250, 300),
  ('786', 'Wałcz', 250, 250, 300),
  ('80', 'Gdańsk', 200, 200, 250),
  ('81', 'Gdynia/Sopot', 200, 200, 250),
  ('82', 'Malbork/Elbląg/Sztum', 200, 200, 250),
  ('83', 'Tczew/Gniew/Kartuzy', 200, 200, 250),
  ('84', 'Puck/Lębork/Wejherowo', 200, 200, 250),
  ('85', 'Bydgoszcz', 250, 250, 300),
  ('86', 'Grudziądz', 250, 250, 300),
  ('87', 'Toruń', 250, 250, 300),
  ('88', 'Inowrocław', 250, 250, 300),
  ('89', 'Więcbork', 250, 250, 300),
  ('90', 'Łódź', 300, 300, 350),
  ('91', 'Łódź', 300, 300, 350),
  ('92', 'Łódź', 300, 300, 350),
  ('93', 'Łódź', 300, 300, 350),
  ('94', 'Łódź', 300, 300, 350),
  ('95', 'Pabianice/Stryków/Ozorków', 300, 300, 350),
  ('961', 'Skierniewice', 300, 300, 350),
  ('962', 'Rawa Mazowiecka', 300, 300, 350),
  ('963', 'Mszczonów', 300, 300, 350),
  ('965', 'Sochaczew', 300, 300, 350),
  ('972', 'Tomaszów Maz.', 300, 350, 400),
  ('973', 'Piotrków Tryb', 300, 300, 350),
  ('974', 'Bełchatów', 300, 300, 350),
  ('975', 'Radomsko', 350, 350, 400),
  ('981', 'Łask', 300, 300, 350),
  ('982', 'Sieradz', 300, 300, 350),
  ('983', 'Wieluń', 350, 400, 450),
  ('984', 'Wieruszów', 350, 400, 450),
  ('99', 'Łęczca/Kutno/okolice', 300, 300, 350)
on conflict (prefix) do nothing;
