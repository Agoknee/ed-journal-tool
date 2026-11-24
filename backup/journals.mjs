import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function getJournalFiles(journalDirPath, count) {
  const allFiles = await readdir(journalDirPath, { withFileTypes: true });
  const logFiles = allFiles.filter(f => f.name.endsWith('.log') && !f.isDirectory());
  const logFileStats = await Promise.all(logFiles.map(async lf => ({
    file: lf,
    stats: await stat(path.join(lf.path, lf.name))
  })));
  logFileStats.sort((a, b) => a.stats.mtime - b.stats.mtime);
  const limitedLogFiles = logFileStats.slice(logFileStats.length - count, logFileStats.length);
  return limitedLogFiles;
}

export async function readJournalFile(journalFilePath) {
  const rawFileData = await readFile(journalFilePath, { encoding: 'utf8' });
  const fileLines = rawFileData.split(/\r?\n/).filter(l => Boolean(l.trim()));
  const fileData = [];
  for (let lineNum = 0; lineNum < fileLines.length; lineNum++) {
    try {
      fileData.push(JSON.parse(fileLines[lineNum]));
    } catch (error) {
      console.log(`Unable to parse line ${lineNum} of "${journalFilePath}"...`);
    }
  }
  return fileData;
}

export async function getJournalEntries(journalFileList) {
  const allJournalFileEntries = {};
  for (const journalFile of journalFileList) {
    const journalFilePath = path.join(journalFile.file.path, journalFile.file.name);
    try {
      const journalFileEntries = await readJournalFile(journalFilePath);
      const commanderEntries = journalFileEntries.filter(e => e.event === 'Commander');
      if (commanderEntries.length < 1) continue;
      if (commanderEntries.length > 1 && [...new Set(commanderEntries.map(c => c.Name))].length > 1) {
        console.log('Journal contains data from multiple commanders!');
        console.log(`Commanders: ${commanderEntries.map(c => c.Name).join(', ')}`);
        console.log(`Path: ${journalFilePath}`);
        throw new Error(`Journal file contains data from multiple commanders: ${commanderEntries.map(c => c.Name).join(', ')}`);
      }
      const commanderName = commanderEntries[0].Name;
      if (Object.keys(allJournalFileEntries).includes(commanderName)) {
        allJournalFileEntries[commanderName].push(...journalFileEntries);
      } else {
        allJournalFileEntries[commanderName] = journalFileEntries;
      }
    } catch (error) {
      console.log(`Error reading journal file "${journalFilePath}":`, error);
    }
  }
  return allJournalFileEntries;
}
