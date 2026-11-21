/**
 * Display formatting helpers.
 */
const integerFormatter = new Intl.NumberFormat();
const decimalFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number.isInteger(Number(value)) ? integerFormatter.format(value) : decimalFormatter.format(value);
}

/** Formats credits compactly, e.g. 2,680,322,874 -> "2.68B cr". */
export function formatCredits(value) {
  if (value === null || value === undefined) return '—';
  const absoluteValue = Math.abs(value);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [threshold, suffix] of units) {
    if (absoluteValue >= threshold) return `${decimalFormatter.format(value / threshold)}${suffix} cr`;
  }
  return `${integerFormatter.format(value)} cr`;
}

export function formatFullCredits(value) {
  return value === null || value === undefined ? '—' : `${integerFormatter.format(value)} cr`;
}

export function formatLightYears(value) {
  return value === null || value === undefined ? '—' : `${decimalFormatter.format(value)} ly`;
}

export function formatDateTime(timestamp) {
  if (!timestamp) return '—';
  const parsedDate = new Date(timestamp);
  return Number.isNaN(parsedDate.getTime()) ? String(timestamp) : dateTimeFormatter.format(parsedDate);
}

export function formatRelativeTime(timestamp) {
  if (!timestamp) return '—';
  const elapsedSeconds = Math.round((Date.now() - new Date(timestamp).getTime()) / 1000);
  const isFuture = elapsedSeconds < 0;
  const absoluteSeconds = Math.abs(elapsedSeconds);
  const steps = [[86400 * 365, 'y'], [86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  const [unitSeconds, unitLabel] = steps.find(([stepSeconds]) => absoluteSeconds >= stepSeconds) ?? [1, 's'];
  const amount = Math.floor(absoluteSeconds / unitSeconds);
  return isFuture ? `in ${amount}${unitLabel}` : `${amount}${unitLabel} ago`;
}

export function formatBytes(byteCount) {
  if (!byteCount) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(byteCount) / Math.log(1024)), units.length - 1);
  return `${decimalFormatter.format(byteCount / 1024 ** unitIndex)} ${units[unitIndex]}`;
}

export function formatDuration(totalSeconds) {
  if (!totalSeconds) return '—';
  const hours = Math.floor(totalSeconds / 3600);
  return hours >= 1 ? `${integerFormatter.format(hours)} h` : `${Math.floor(totalSeconds / 60)} m`;
}

/** "cobramkiii" style internal ship names are shown as-is when no localised name exists. */
export function formatShipName(shipType, shipName) {
  if (!shipType && !shipName) return '—';
  return shipName ? `${shipName} (${shipType})` : shipType;
}

/**
 * Short designations shown with certain system names, e.g. "N0 (HIP 58832)".
 * Matching ignores letter case and spacing.
 */
const SYSTEM_DESIGNATIONS = {
  'HIP 58832': 'N0',
  'HD 105341': 'N1',
  'HD 104495': 'N2',
  'HIP 57784': 'N3',
  'HIP 57478': 'N4',
  'HIP 56843': 'N5',
  'HD 104392': 'N6',
  'HD 102779': 'N7',
  'HD 102000': 'N8',
  'HD 104785': 'N9',
  'HD 105548': 'N10',
  'HD 107865': 'N11',
  'Plaa Trua WQ-C d13-0': 'N12',
  'Plaa Trua QL-B c27-0': 'N13',
  'Wregoe OP-D b58-0': 'N14',
  'Wregoe ZE-B c28-2': 'N15',
  'Wregoe NA-W b57-4': 'N16',
};

const normalizeSystemName = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const designationsByNormalizedName = new Map(
  Object.entries(SYSTEM_DESIGNATIONS).map(([systemName, designation]) => [normalizeSystemName(systemName), designation]),
);

/** The designation for a system name, or for a body name that starts with one ("HIP 57784 1 b" -> "N3"). */
export function getSystemDesignation(name) {
  if (!name) return null;
  const normalizedName = normalizeSystemName(name);
  const exactMatch = designationsByNormalizedName.get(normalizedName);
  if (exactMatch) return exactMatch;
  for (const [systemName, designation] of designationsByNormalizedName) {
    if (normalizedName.startsWith(`${systemName} `)) return designation;
  }
  return null;
}

/** "HIP 58832" -> "N0 (HIP 58832)"; other names, and null/undefined, are returned unchanged. */
export function formatSystemName(name) {
  const designation = getSystemDesignation(name);
  return designation ? `${designation} (${name})` : name;
}
