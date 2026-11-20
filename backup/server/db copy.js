const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync('journals.db');

// Create tables if they don't exist
database.exec(`
  CREATE TABLE IF NOT EXISTS rawjournalfiles (
    id INTEGER PRIMARY KEY,
    filename TEXT UNIQUE,
    mtime REAL,
    data TEXT
  ) STRICT
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS journalcmdrs (
    filename TEXT UNIQUE,
    cmdrfid TEXT,
    cmdrname TEXT
  ) STRICT
`);

database.exec(`
  CREATE TABLE IF NOT EXISTS carriers (
    id TEXT UNIQUE,
    name TEXT,
    marketid TEXT
  ) STRICT
`);

const journalcmdrs = [...(database.prepare('SELECT * FROM journalcmdrs').iterate() || [])];
const carriers = [...(database.prepare('SELECT * FROM carriers').iterate() || [])];

function getJournalCmdr (journalData) {
  if (!journalData) return;
  const commanderEntries = journalData.filter(e => e.event === 'Commander');
  if (commanderEntries.length < 1) return;
  if (commanderEntries.length > 1 && [...new Set(commanderEntries.map(c => c.Name))].length > 1) {
    console.error(`Journal contains data from multiple commanders!`);
    console.error(`Commanders: ${commanderEntries.map(c => c.Name).join(', ')}`);
    return;
  }
  const fid = commanderEntries[0].FID;
  const name = commanderEntries[0].Name;
  return { fid, name };
}

function getJournalCarriers(journalData) {
  if (!journalData) return [];
  let modified = false;
  const fssCarrierSignalEntries = journalData.filter(e => e.event === 'FSSSignalDiscovered' && e.SignalType === 'FleetCarrier');
  for (const entry of fssCarrierSignalEntries) {
    const name = entry.SignalName.substring(0, entry.SignalName.length - 7).trim();
    const id = entry.SignalName.substring(entry.SignalName.length - 7);
    const existingIndex = carriers.findIndex(c => c.id === id);
    if (existingIndex > -1 && carriers[existingIndex].name !== name) {
      carriers[existingIndex].name = name;
      modified = true;
    } else {
      const marketid = journalData.find(e => e.event === 'SupercruiseDestinationDrop' && e.Type === entry.SignalName)?.MarketID;
      carriers.push({ id, name, marketid });
      modified = true;
    }
  }

  // Check for missing market IDs
  const missingMarkets = carriers.filter(c => !Boolean(c.marketid));
  if (missingMarkets.length) {
    const scDestDropEntries = journalData.find(e => e.event === 'SupercruiseDestinationDrop');
    if (scDestDropEntries) {
      for (const missing of missingMarkets) {
        const match = scDestDropEntries.find(e => e.Type === `${missing.name} ${missing.id}`);
        if (match) {
          carriers[carriers.findIndex(c => c.id = missing.id)].marketid = match.MarketID;
          modified = true;
        }
      }
    }
  }

  if (modified) {
    // figure out how to update all modified entries in db

    // let retries = 0;
    // function writeData () {
    //   try {

    //   } catch {
    //     retries++;
    //     if (retries < 6) setTimeout(writeData, 500);
    //   }
    // }
  }
}

function addJournalCmdr (filename, data) {
  const journalCmdr = getJournalCmdr(data);
  let retries = 0;
  function writeData () {
    try {
      const upsert = database.prepare('INSERT INTO journalcmdrs (filename, cmdrfid, cmdrname) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
      upsert.run(filename, journalCmdr.fid, journalCmdr.name);
      journalcmdrs.push({ filename, fid: journalCmdr.fid, name: journalCmdr.name });
    } catch {
      retries++;
      if (retries < 6) setTimeout(writeData, 500);
    }
  }
  if (journalCmdr) writeData();
}

function updateJournalFile (filename, mtime, data) {
  const exists = database.prepare('SELECT mtime, data FROM rawjournalfiles WHERE filename = ?').get(filename);
  if (exists) {
    // Existing journal file
    console.log(`Update received for existing journal file: ${filename}`);
    if (exists.mtime !== mtime) {
      const newData = JSON.parse(exists.data);
      newData.push(...data.slice(newData.length));
      let retries = 0;
      function writeData () {
        try {
          const updateQuery = database.prepare('UPDATE rawjournalfiles SET data = ? WHERE filename = ?');
          updateQuery.run(JSON.stringify(newData), filename);
        } catch {
          retries++;
          if (retries < 6) setTimeout(writeData, 500);
        }
      }
      writeData();
    }
  } else {
    // New journal file
    let retries = 0;
    function writeData () {
      try {
        const insert = database.prepare('INSERT INTO rawjournalfiles (filename, mtime, data) VALUES (?, ?, ?)');
        insert.run(filename, mtime, JSON.stringify(data));
      } catch {
        retries++;
        if (retries < 6) setTimeout(writeData, 500);
      }
    }
    writeData();
  }

  if (!journalcmdrs.find(jc => jc.filename === filename)) {
    addJournalCmdr(filename, data);
  }

  getJournalCarriers(data);
}



// SELECT rawjournalfiles.filename, cmdrname FROM rawjournalfiles
// INNER JOIN journalcmdrs ON rawjournalfiles.filename = journalcmdrs.filename
// WHERE cmdrname = "AGONEYES"
// ORDER BY `cmdrfid` ASC;

// SELECT DISTINCT cmdrname, cmdrfid FROM journalcmdrs


module.exports = {
  database,
  journalcmdrs,
  carriers,
  updateJournalFile
};
