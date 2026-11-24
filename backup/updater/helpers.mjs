import path from 'node:path';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const appDataPath = path.join(process.env.LOCALAPPDATA, 'ed-journal-uploader');
try { await mkdir(appDataPath) } catch {}

// Logging
const logFilePath = path.join(appDataPath, 'log.txt');

export const logger = {
  log: (...args) => {
    console.log(...args);
    appendFile(logFilePath, `[INFO] ${args.map(a => a.toString()).join(' ')}\n`);
  },
  warn: (...args) => {
    console.warn(...args);
    appendFile(logFilePath, `[WARN] ${args.map(a => a.toString()).join(' ')}\n`);
  },
  error: (...args) => {
    console.error(...args);
    appendFile(logFilePath, `[ERROR] ${args.map(a => a.toString()).join(' ')}\n`);
  }
};


// Handling list of processed files (processed.json)
const processedListFilePath = path.join(appDataPath, 'processed.json');
let processedFiles = [];

export async function getProcessedFiles () {
  try {
    processedFiles = JSON.parse(await readFile(processedListFilePath, 'utf8'));
  } catch (error) {
    logger.error('Unable to read processed.json:\n', error);
  }
}

async function putProcessedFiles () {
  try {
    await writeFile(processedListFilePath, JSON.stringify(processedFiles));
  } catch (error) {
    logger.error('Unable to write processed.json:\n', error);
  }
}

async function updateProcessedFiles (filePath, fileMtime) {
  const existing = processedFiles.find(f => f.filePath === filePath);
  if (existing) {
    existing.fileMtime = fileMtime;
  } else {
    processedFiles.push({ filePath, fileMtime });
  }
  putProcessedFiles();
}

export async function processFile (fileEvent, filePath, fileMtime) {
  if (processedFiles.find(f => f.filePath === filePath && f.fileMtime === fileMtime)) return;

  // process file
  logger.log(`Processing ${fileEvent === 'add' ? 'new' : 'modified'} file: ${filePath}`);
  const fileData = await readJournalFile(filePath);
  if (!fileData.length) return;

  try {
    await uploadJournalData(filePath, fileMtime, fileData);
  } catch (error) {
    logger.error('Unable to upload journal data:\n', error);
    // TODO: retry and/or throttle uploads
    return;
  }

  // update processedFiles (if processing was successful)
  updateProcessedFiles(filePath, fileMtime);
}

async function readJournalFile(journalFilePath) {
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


async function uploadJournalData (filePath, fileMtime, fileData) {
  // pull from CLI or ENV
  const appToken = 'eyJ1c2VyIjoidXNlciIsImFwcFRva2VuIjoidGVzdFRva2VuIn0=';
  const serverUrl = 'http://localhost:4000/api/journalupdate';
  await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filename: path.basename(filePath), mtime: fileMtime, data: fileData }),
  });
}
