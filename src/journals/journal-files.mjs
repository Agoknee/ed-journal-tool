/**
 * Helpers for recognising journal file names and ordering them chronologically.
 *
 * Elite Dangerous has used two file name formats:
 *   Journal.2023-08-07T220129.01.log   (current)
 *   Journal.250110161439.01.log        (legacy, YYMMDDHHMMSS)
 */
const currentFormatPattern = /^Journal\.(\d{4}-\d{2}-\d{2})T(\d{6})\.(\d+)\.log$/i;
const legacyFormatPattern = /^Journal\.(\d{2})(\d{2})(\d{2})(\d{6})\.(\d+)\.log$/i;

/**
 * Whether a journal was written by the Legacy game client (Horizons 3.8, with its own galaxy and
 * commander saves) rather than the live game, from its Fileheader game version (3.x or older).
 * @param {string | null} gameVersion
 */
export function isLegacyGameVersion(gameVersion) {
  return /^[0-3]\./.test(gameVersion ?? '');
}

export function isJournalFileName(fileName) {
  return currentFormatPattern.test(fileName) || legacyFormatPattern.test(fileName);
}

/**
 * Builds a sortable key like "2023-08-07T220129.01" from a journal file name.
 * @param {string} fileName
 */
export function getJournalSortKey(fileName) {
  const currentMatch = fileName.match(currentFormatPattern);
  if (currentMatch) {
    const [, datePart, timePart, filePart] = currentMatch;
    return `${datePart}T${timePart}.${filePart.padStart(2, '0')}`;
  }

  const legacyMatch = fileName.match(legacyFormatPattern);
  if (legacyMatch) {
    const [, year, month, day, timePart, filePart] = legacyMatch;
    return `20${year}-${month}-${day}T${timePart}.${filePart.padStart(2, '0')}`;
  }

  return fileName;
}

export function compareJournalFileNames(firstFileName, secondFileName) {
  return getJournalSortKey(firstFileName).localeCompare(getJournalSortKey(secondFileName));
}
