/**
 * BGS activity reporting in the style of the BGS-Tally EDMC plugin: one ```ansi block per system
 * for Discord, with the same labels, colours and number abbreviations, so squadron channels that
 * read BGS-Tally reports can read these too.
 */

const ESCAPE = '\u001b';
const ANSI_COLOURS = { grey: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37 };

function ansi(text, colour, isBold = false) {
  const codes = [ANSI_COLOURS[colour], isBold && 1].filter(Boolean).join(';');
  return `${ESCAPE}[${codes}m${text}${ESCAPE}[0m`;
}

/**
 * Credits and other large numbers as BGS-Tally shows them: three significant digits with a K/M/B/T
 * suffix and no trailing zeros (1234 -> 1.23K, 1300000 -> 1.3M, 450000 -> 450K).
 */
export function formatBgsNumber(value) {
  const roundedValue = Math.round(value);
  if (Math.abs(roundedValue) < 1000) return String(roundedValue);
  const suffixes = ['', 'K', 'M', 'B', 'T'];
  let scaledValue = roundedValue;
  let suffixIndex = 0;
  while (Math.abs(scaledValue) >= 1000 && suffixIndex < suffixes.length - 1) {
    scaledValue /= 1000;
    suffixIndex += 1;
  }
  // Rounding can carry into the next unit (999.6K -> 1M).
  if (Math.abs(Number(scaledValue.toPrecision(3))) >= 1000 && suffixIndex < suffixes.length - 1) {
    scaledValue /= 1000;
    suffixIndex += 1;
  }
  return `${Number(scaledValue.toPrecision(3))}${suffixes[suffixIndex]}`;
}

function formatInfluence(value) {
  return value > 0 ? `+${value}` : String(value);
}

/** The influence total shown for a faction: primary, plus secondary when included. */
export function getInfluenceTotal(totals, includeSecondaryInf) {
  return (totals.infPrimary ?? 0) + (includeSecondaryInf ? totals.infSecondary ?? 0 : 0);
}

/** "INF", or "WarINF"/"ElectionINF" while the faction is in a conflict, as BGS-Tally labels it. */
export function getInfluenceLabel(factionState) {
  if (factionState === 'War' || factionState === 'CivilWar') return 'WarINF';
  if (factionState === 'Election') return 'ElectionINF';
  return 'INF';
}

const CZ_SIZES = [['l', 'L'], ['m', 'M'], ['h', 'H']];
// Space conflict zone objectives in BGS-Tally's order, with its Discord symbols.
export const CZ_OBJECTIVES = [
  ['cs', '👑', 'Cap Ship'],
  ['so', '🔠', 'Spec Ops'],
  ['cp', '👨‍✈️', 'Captain'],
  ['pr', '✒️', 'Propagandist'],
];

/** Report items after INF, in BGS-Tally's order: [label, colour, getValue(totals), format]. Conflict zones and S&R follow. */
const REPORT_ITEMS = [
  ['BVs', 'red', (totals) => totals.bounties, formatBgsNumber],
  ['CBs', 'red', (totals) => totals.combatBonds, formatBgsNumber],
  ['TrdBuy', 'cyan', (totals) => totals.tradeBuy, formatBgsNumber],
  ['TrdProfit', 'cyan', (totals) => totals.tradeProfit, formatBgsNumber],
  ['TrdBMProfit', 'cyan', (totals) => totals.blackMarketProfit, formatBgsNumber],
  ['Expl', 'white', (totals) => totals.exploration, formatBgsNumber],
  ['Exo', 'white', (totals) => totals.organic, formatBgsNumber],
  ['Murders', 'red', (totals) => totals.murders, String],
  ['GroundMurders', 'red', (totals) => totals.groundMurders, String],
  ['Scenarios', 'yellow', (totals) => totals.scenarios, String],
  ['Fails', 'magenta', (totals) => totals.missionsFailed, String],
];

/** One faction's report line, or null when it has nothing to report. */
function buildFactionLine(faction, includeSecondaryInf) {
  const parts = [];
  const influence = getInfluenceTotal(faction.totals, includeSecondaryInf);
  if (influence) parts.push(`${ansi(getInfluenceLabel(faction.state), 'blue')} ${ansi(formatInfluence(influence), 'green')}`);

  for (const [label, colour, getValue, format] of REPORT_ITEMS) {
    const value = getValue(faction.totals);
    if (value) parts.push(`${ansi(label, colour)} ${ansi(format(value), 'green')}`);
  }
  for (const [label, totalsKey, objectivesKey] of [['SpaceCZs', 'spaceCz', 'spaceCzObjectives'], ['GroundCZs', 'groundCz', null]]) {
    const czParts = CZ_SIZES
      .filter(([size]) => faction.totals[totalsKey]?.[size])
      .map(([size, sizeLabel]) => `${sizeLabel} x ${ansi(String(faction.totals[totalsKey][size]), 'green')}`);
    const objectiveCounts = faction.totals[objectivesKey] ?? {};
    const objectiveParts = CZ_OBJECTIVES
      .filter(([objective]) => objectiveCounts[objective])
      .map(([objective, symbol]) => `${symbol}:${ansi(String(objectiveCounts[objective]), 'green')}`);
    if (objectiveParts.length > 0) czParts.push(`(${objectiveParts.join(' ')})`);
    if (czParts.length > 0) parts.push(`${ansi(label, 'red')} ${czParts.join(' ')}`);
  }
  if (faction.totals.searchAndRescue) parts.push(`${ansi('SandR', 'white')} ${ansi(String(faction.totals.searchAndRescue), 'green')}`);

  if (parts.length === 0) return null;
  return `${ansi(faction.name, 'yellow', true)} ${parts.join(' ')}`;
}

/** One system's ```ansi block, or null when none of its factions has anything to report. */
export function buildSystemReport(system, { includeSecondaryInf }) {
  const factionLines = system.factions.map((faction) => buildFactionLine(faction, includeSecondaryInf)).filter(Boolean);
  if (factionLines.length === 0) return null;
  const systemName = system.starSystem ?? `System #${system.systemAddress}`;
  // BGS-Tally strips apostrophes from its reports.
  return `\`\`\`ansi\n${ansi(systemName, 'white', true)}\n${factionLines.join('\n')}\n\`\`\``.replaceAll("'", '');
}

/** The full report: an optional heading line, then each system's block. */
export function buildReport(systems, { heading, includeSecondaryInf }) {
  const systemReports = systems.map((system) => buildSystemReport(system, { includeSecondaryInf })).filter(Boolean);
  return [heading, ...systemReports].filter(Boolean).join('\n');
}
