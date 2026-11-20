import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import store from './store.mjs';
const { getState, setState } = store;

import { db } from './db.mjs';

export async function getJournalFiles(journalDirPath, count = 0) {
  const allFiles = await readdir(journalDirPath, { withFileTypes: true });
  const logFiles = allFiles.filter(f => f.name.endsWith('.log') && !f.isDirectory());
  const logFileStats = await Promise.all(logFiles.map(async lf => ({
    file: lf,
    stats: await stat(path.join(lf.path, lf.name))
  })));
  logFileStats.sort((a, b) => a.stats.mtime - b.stats.mtime);
  const limitedLogFiles = count > 0 ? logFileStats.slice(logFileStats.length - count, logFileStats.length) : logFileStats;
  return limitedLogFiles;
}

const findJournalFileQuery = db.prepare('SELECT * FROM journal_files WHERE filepath = ?');
export async function checkJournalFile(journalFile) {
    const filePath = journalFile.file.path + journalFile.file.name;
    const lastSize = journalFile.stats.size; // try checking the size of string after readFile and comparing

    const result = findJournalFileQuery.get(filePath);
    if (result?.last_read_size === lastSize) return;

    processJournalFile(filePath);
}

const journalQueue = [];
let journalQueueProcessing = false;
function processJournalFile(journalFilePath) {
  if (journalQueue.includes(journalFilePath)) return;
  journalQueue.push(journalFilePath);
  processNextQueuedJournal();
}
async function processNextQueuedJournal () {
  if (journalQueueProcessing || journalQueue.length < 1) return;
  journalQueueProcessing = true;

  // scrap this and use state queue?

  // const i = db.prepare('INSERT INTO journal_files (filepath) VALUES (?)');
  // i.run(filePath);

  journalQueueProcessing = false;
  processNextQueuedJournal();
}