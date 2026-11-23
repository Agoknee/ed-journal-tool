/**
 * Ship engineering materials: category, family (the material trader groups, each running grade 1
 * to 5) and grade, keyed by the journal's lowercase name. The game caps how many of each you can
 * hold by grade. Guardian, Thargoid and other special materials aren't in a graded family here, so
 * they're shown without a grade or cap.
 */
export const MAX_BY_GRADE = { 1: 300, 2: 250, 3: 200, 4: 150, 5: 100 };

const FAMILIES = {
  raw: {
    'Raw 1': ['carbon', 'vanadium', 'niobium', 'yttrium'],
    'Raw 2': ['phosphorus', 'chromium', 'molybdenum', 'technetium'],
    'Raw 3': ['sulphur', 'manganese', 'cadmium', 'ruthenium'],
    'Raw 4': ['iron', 'zinc', 'tin', 'selenium'],
    'Raw 5': ['nickel', 'germanium', 'tungsten', 'tellurium'],
    'Raw 6': ['rhenium', 'arsenic', 'mercury', 'polonium'],
    'Raw 7': ['lead', 'zirconium', 'boron', 'antimony'],
  },
  manufactured: {
    Chemical: ['chemicalstorageunits', 'chemicalprocessors', 'chemicaldistillery', 'chemicalmanipulators', 'pharmaceuticalisolators'],
    Thermic: ['temperedalloys', 'heatresistantceramics', 'precipitatedalloys', 'thermicalloys', 'militarygradealloys'],
    Heat: ['heatconductionwiring', 'heatdispersionplate', 'heatexchangers', 'heatvanes', 'protoheatradiators'],
    Conductive: ['basicconductors', 'conductivecomponents', 'conductiveceramics', 'conductivepolymers', 'biotechconductors'],
    'Mechanical Components': ['mechanicalscrap', 'mechanicalequipment', 'mechanicalcomponents', 'configurablecomponents', 'improvisedcomponents'],
    Capacitors: ['gridresistors', 'hybridcapacitors', 'electrochemicalarrays', 'polymercapacitors', 'militarysupercapacitors'],
    Shielding: ['wornshieldemitters', 'shieldemitters', 'shieldingsensors', 'compoundshielding', 'imperialshielding'],
    Composite: ['compactcomposites', 'filamentcomposites', 'highdensitycomposites', 'fedproprietarycomposites', 'fedcorecomposites'],
    Crystals: ['crystalshards', 'uncutfocuscrystals', 'focuscrystals', 'refinedfocuscrystals', 'exquisitefocuscrystals'],
    Alloys: ['salvagedalloys', 'galvanisingalloys', 'phasealloys', 'protolightalloys', 'protoradiolicalloys'],
  },
  encoded: {
    'Emission Data': ['scrambledemissiondata', 'archivedemissiondata', 'emissiondata', 'decodedemissiondata', 'compactemissionsdata'],
    'Wake Scans': ['disruptedwakeechoes', 'fsdtelemetry', 'wakesolutions', 'hyperspacetrajectories', 'dataminedwake'],
    'Shield Data': ['shieldcyclerecordings', 'shieldsoakanalysis', 'shielddensityreports', 'shieldpatternanalysis', 'shieldfrequencydata'],
    'Encryption Files': ['encryptedfiles', 'encryptioncodes', 'symmetrickeys', 'encryptionarchives', 'adaptiveencryptors'],
    'Data Archives': ['bulkscandata', 'scanarchives', 'scandatabanks', 'encodedscandata', 'classifiedscandata'],
    'Encoded Firmware': ['legacyfirmware', 'consumerfirmware', 'industrialfirmware', 'securityfirmware', 'embeddedfirmware'],
  },
};

// Guardian and Thargoid materials don't form a grade 1-5 run, so their grades are listed one by one.
const SPECIAL_MATERIALS = {
  guardian_powercell: ['manufactured', 'Guardian', 1],
  guardian_sentinel_wreckagecomponents: ['manufactured', 'Guardian', 1],
  guardian_powerconduit: ['manufactured', 'Guardian', 2],
  guardian_techcomponent: ['manufactured', 'Guardian', 3],
  guardian_sentinel_weaponparts: ['manufactured', 'Guardian', 3],
  unknowncarapace: ['manufactured', 'Thargoid', 2],
  tg_causticshard: ['manufactured', 'Thargoid', 2],
  tg_wreckagecomponents: ['manufactured', 'Thargoid', 3],
  tg_causticgeneratorparts: ['manufactured', 'Thargoid', 3],
  tg_causticcrystal: ['manufactured', 'Thargoid', 4],
  tg_propulsionelement: ['manufactured', 'Thargoid', 5],
  unknownorganiccircuitry: ['manufactured', 'Thargoid', 5],
  unknownenergycell: ['manufactured', 'Thargoid', 3],
  unknowntechnologycomponents: ['manufactured', 'Thargoid', 4],
  unknownenergysource: ['manufactured', 'Thargoid', 5],
  ancienthistoricaldata: ['encoded', 'Guardian', 1],
  ancientculturaldata: ['encoded', 'Guardian', 2],
  ancientbiologicaldata: ['encoded', 'Guardian', 3],
  ancientlanguagedata: ['encoded', 'Guardian', 4],
  ancienttechnologicaldata: ['encoded', 'Guardian', 4],
  guardian_moduleblueprint: ['encoded', 'Guardian', 5],
  guardian_weaponblueprint: ['encoded', 'Guardian', 5],
  tg_shipflightdata: ['encoded', 'Thargoid', 3],
  tg_shipsystemsdata: ['encoded', 'Thargoid', 3],
};

/** @type {Map<string, { category: string, family: string, grade: number, maxCount: number }>} */
export const MATERIALS = new Map([
  ...Object.entries(FAMILIES).flatMap(([category, families]) => Object.entries(families).flatMap(([family, names]) => names.map((name, index) => [
    name,
    { category, family, grade: index + 1, maxCount: MAX_BY_GRADE[index + 1] },
  ]))),
  ...Object.entries(SPECIAL_MATERIALS).map(([name, [category, family, grade]]) => [name, { category, family, grade, maxCount: MAX_BY_GRADE[grade] }]),
]);

/** Grade, family and storage cap for a material (by its journal name), or null for special materials. */
export function describeMaterial(name) {
  return MATERIALS.get(String(name ?? '').toLowerCase()) ?? null;
}
