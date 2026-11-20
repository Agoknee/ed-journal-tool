import { open } from 'node:fs/promises';

const NEWLINE_BYTE = 0x0a;

/**
 * Reads complete journal lines starting at a byte offset. The file is opened read-only.
 *
 * A journal line is only consumed when it is complete:
 *  - lines without a trailing newline are left for the next read (unless the file is settled)
 *  - lines that fail to parse stop the read so they can be retried later, since the game may
 *    still be writing them (unless the file is settled or skipping is forced)
 *
 * @param {string} filePath
 * @param {object} options
 * @param {number} options.startOffset      byte offset to start reading from
 * @param {number} options.endOffset        byte offset to stop at (normally the file size)
 * @param {number} options.startLineNumber  number of lines already consumed before startOffset
 * @param {boolean} options.isSettled       the file is no longer being written
 * @param {boolean} options.skipUnparseable skip bad lines instead of waiting for them
 */
export async function readJournalLines(filePath, { startOffset, endOffset, startLineNumber, isSettled, skipUnparseable }) {
  const fileBuffer = await readByteRange(filePath, startOffset, endOffset);

  const parsedLines = [];
  let bufferPosition = 0;
  let lineNumber = startLineNumber;
  let skippedLineCount = 0;
  let isBlockedByBadLine = false;

  while (bufferPosition < fileBuffer.length) {
    const newlineIndex = fileBuffer.indexOf(NEWLINE_BYTE, bufferPosition);
    const isLineTerminated = newlineIndex !== -1;

    if (!isLineTerminated && !isSettled) break; // the game is probably still writing this line

    const lineEndIndex = isLineTerminated ? newlineIndex : fileBuffer.length;
    const lineText = fileBuffer.toString('utf8', bufferPosition, lineEndIndex).trim();

    if (lineText) {
      const journalEntry = parseJournalLine(lineText);
      if (journalEntry) {
        parsedLines.push({ lineNumber: lineNumber + 1, journalEntry, rawLine: lineText });
      } else if (isSettled || skipUnparseable) {
        skippedLineCount += 1;
      } else {
        isBlockedByBadLine = true;
        break;
      }
    }

    lineNumber += 1;
    bufferPosition = isLineTerminated ? newlineIndex + 1 : fileBuffer.length;
  }

  return {
    parsedLines,
    bytesConsumed: bufferPosition,
    linesConsumed: lineNumber - startLineNumber,
    skippedLineCount,
    isBlockedByBadLine,
  };
}

function parseJournalLine(lineText) {
  try {
    const journalEntry = JSON.parse(lineText);
    const isValidEntry = journalEntry && typeof journalEntry === 'object' && typeof journalEntry.event === 'string';
    return isValidEntry ? journalEntry : null;
  } catch {
    return null;
  }
}

async function readByteRange(filePath, startOffset, endOffset) {
  const byteLength = Math.max(0, endOffset - startOffset);
  const fileBuffer = Buffer.alloc(byteLength);
  if (byteLength === 0) return fileBuffer;

  const fileHandle = await open(filePath, 'r');
  try {
    let totalBytesRead = 0;
    while (totalBytesRead < byteLength) {
      const { bytesRead } = await fileHandle.read(fileBuffer, totalBytesRead, byteLength - totalBytesRead, startOffset + totalBytesRead);
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    return fileBuffer.subarray(0, totalBytesRead);
  } finally {
    await fileHandle.close();
  }
}
