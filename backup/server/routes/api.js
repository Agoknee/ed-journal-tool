const express = require('express');

const { database, getAllCarriers, getJournalCmdrs, updateJournalFile } = require('../db');

const router = express.Router();

router.post('/journalupdate', (req, res, next) => {
  if (!req.body?.filename || !req.body?.mtime || !req.body?.data) {
    const err = new Error('Invalid request body.');
    err.status = 400;
    return next(err);
  }

  const { filename, mtime, data } = req.body;
  updateJournalFile(filename, mtime, data);

  // const existsQuery = database.prepare('SELECT mtime, data FROM rawjournalfiles WHERE filename = ?');
  // const exists = existsQuery.get(filename);
  // if (exists) {
  //   // Existing journal file
  //   const existingData = JSON.parse(exists.data);
  //   console.log(`Update received for existing journal file: ${filename}`);
  //   if (exists.mtime !== mtime) {
  //     existingData.push(...data.slice(existingData.length));
  //     const updateQuery = database.prepare('UPDATE rawjournalfiles SET data = ? WHERE filename = ?');
  //     updateQuery.run(JSON.stringify(data), filename);
  //   }
  // } else {
  //   // New journal file
  //   console.log(`New journal file received: ${filename}`);
  //   addJournalFile(filename, mtime, data);
  // }

  res.json({ status: 'success' });

});

router.get('/journalcmdrs', (req, res) => {
  res.json(getJournalCmdrs());
});

router.get('/cmdrs', (req, res) => {
  res.json([...database.prepare('SELECT DISTINCT cmdrname, cmdrfid FROM journalcmdrs').iterate()]);
});

router.get('/allcarriers', (req, res) => {
  res.json(getAllCarriers());
});


module.exports = router;
