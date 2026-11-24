import path from 'node:path';
import chokidar from 'chokidar';
import { getProcessedFiles, logger, processFile } from './helpers.mjs';

// Determine journal directory
const defaultJournalDirPath = path.join(process.env.USERPROFILE, 'Saved Games/Frontier Developments/Elite Dangerous');
global.journalDirPath = defaultJournalDirPath;

await getProcessedFiles();

function watchIgnoredHandler (filePath, fileStats) {
  // Ignore any non-journal files/directories
  return fileStats?.isFile() && !filePath.startsWith('Journal') && !filePath.endsWith('.log');
}
const watcher = chokidar.watch(journalDirPath, { depth: 0, ignored: watchIgnoredHandler });

watcher.on('all', (fileEvent, filePath, fileStats) => {
  if (['addDir', 'unlink'].includes(fileEvent)) {
    return;
  } else if (['add', 'change'].includes(fileEvent)) {
    processFile(fileEvent, filePath.toString(), fileStats.mtimeMs);
  } else {
    logger.log('Unexpected watch event:\n', JSON.stringify({ fileEvent, filePath, fileStats }));
  }
});
