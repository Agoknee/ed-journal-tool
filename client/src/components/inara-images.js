// The game's insignia artwork (from Inara), downloaded into the data folder the first time EDJT runs
// and served at /inara (src/assets/inara-assets.mjs; it isn't in the repository). Pilots' Federation ranks have an
// image per rank (index 0-13, Elite I-V included); each navy has one emblem; powers have a portrait.
const INARA_IMAGE_BASE = `${import.meta.env.BASE_URL}inara`;
const INARA_RANK_TYPES = { Combat: 1, Trade: 2, Explore: 3, CQC: 4, Soldier: 5, Exobiologist: 6 };
const INARA_NAVY_TYPES = { Empire: 12, Federation: 13 };
const INARA_POWERS = {
  'Denton Patreus': 1, 'Aisling Duval': 2, 'Edmund Mahon': 3, 'Arissa Lavigny-Duval': 4, 'Felicia Winters': 5,
  'Li Yong-Rui': 7, 'Zemina Torval': 8, 'Pranav Antal': 9, 'Archon Delaine': 10, 'Yuri Grom': 11,
  'Jerome Archer': 12, 'Nakato Kaine': 13,
};

/** The insignia image for a rank type ("Combat", "Federation", ...) at a rank index, or null. */
export function getRankImageUrl(rankType, rankIndex) {
  if (INARA_NAVY_TYPES[rankType]) return `${INARA_IMAGE_BASE}/ranks/${INARA_NAVY_TYPES[rankType]}-0.png`;
  if (INARA_RANK_TYPES[rankType] && Number.isInteger(rankIndex)) return `${INARA_IMAGE_BASE}/ranks/${INARA_RANK_TYPES[rankType]}-${rankIndex}.png`;
  return null;
}

/** The emblem for a superpower; only the Federation and Empire have one (their navy's). */
export function getSuperpowerImageUrl(superpower) {
  return INARA_NAVY_TYPES[superpower] ? `${INARA_IMAGE_BASE}/ranks/${INARA_NAVY_TYPES[superpower]}-0.png` : null;
}

/** A power's portrait, or null for an unknown power. */
export function getPowerImageUrl(power) {
  return INARA_POWERS[power] ? `${INARA_IMAGE_BASE}/powers/${INARA_POWERS[power]}.jpg` : null;
}

/** An engineer's portrait by its image id (from the engineers API), or null. */
export function getEngineerImageUrl(imageId) {
  return imageId ? `${INARA_IMAGE_BASE}/engineers/${imageId}.jpg` : null;
}

/** Hides an image whose file isn't there (not downloaded yet), rather than showing a broken one. */
export function hideMissingImage(errorEvent) {
  errorEvent.currentTarget.style.visibility = 'hidden';
}
