-- Trzeci typ zlecenia: KRAJÓWKA (właściciel: "musimy dodać trzeci typ zlecenia - krajówka,
-- zaliczamy do exportów ale są one zawsze nadrzędne (nad nimi) w zestawieniu, w planie wspaniałym
-- też to będzie podpięte pod export").
--
-- Dlaczego trzecia WARTOŚĆ `direction`, a nie osobna flaga „is_domestic" obok direction='E':
-- krajówka ma w Zestawieniu własny blok STOJĄCY NAD eksportem, czyli jest osobną grupą, a nie
-- odmianą eksportu. Grupowanie idzie po `direction`, więc flaga wymagałaby drugiego poziomu
-- grupowania tylko dla jednego przypadku. Jednocześnie WSZĘDZIE, gdzie liczy się „strona zestawu"
-- (Plan wspaniały, etykiety załadunku, trasa na fakturze), krajówka zachowuje się jak eksport —
-- w appce decyduje o tym JEDNA funkcja `isExportSide()` (src/lib/loads/direction.ts), żeby nie
-- rozsypać tej reguły po dziesięciu porównaniach `=== "E"`.
--
-- Indeks (load_date, direction) z 0001 obsługuje nową wartość bez zmian.

alter table public.loads drop constraint if exists loads_direction_check;

alter table public.loads
  add constraint loads_direction_check
  check (direction in ('I', 'E', 'K'));

comment on column public.loads.direction is
  'I = import, E = eksport, K = krajówka (transport krajowy; liczy się do eksportów, ale w Zestawieniu stoi nad nimi)';
