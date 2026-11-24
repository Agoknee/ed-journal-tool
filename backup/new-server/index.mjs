import path from 'node:path';
import express from 'express';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import store from './util/store.mjs';
const { getState, setState } = store;

import './util/db.mjs';
import { getJournalFiles, checkJournalFile } from './util/journals.mjs';

// import { createServer } from 'node:http';

// Parse CLI arguments
const argv = yargs(hideBin(process.argv))
    .option('port', {
        alias: 'p',
        describe: 'Port server will listen on',
        default: 4267,
    })
    .option('bind', {
        alias: 'b',
        describe: 'Host/IP server will bind to'
    })
    .option('debug', {
        alias: 'd',
        describe: 'Run in debug mode (extra logging)',
        boolean: true,
        default: false,
    })
    .option('journaldir', {
        alias: 'j',
        describe: 'path to journal directory',
        array: true,
        default: path.join(process.env.USERPROFILE, 'Saved Games/Frontier Developments/Elite Dangerous'),
    })
    .help()
    .parse();
getState().setConfig((config) => ({ ...config, argv, debug: argv.debug }));

// Scan/validate all journalDirs - exit if none are valid
console.log('Scanning journal directories...');
const journalDirs = [];
for (const journalDir of argv.journaldir) {
    try {
        const journalFiles = await getJournalFiles(path.resolve(journalDir));
        if (journalFiles.length < 1) throw new Error('No journal files found.');
        journalDirs.push(journalDir);

        // Queue processing of any new/updated journal files
        for (const journalFile of journalFiles) {
            checkJournalFile(journalFile);
        }
    } catch (error) {
        console.log(`Unable to read journal directory: ${journalDir}`);
        console.debug(error);
    }
}
if (journalDirs.length < 1) {
    console.log('No valid journal directories specified. Exiting!');
    process.exit(1);
}
getState().setConfig((config) => ({ ...config, journalDirs }));

// Start web server
// const app = express();
// const httpServer = createServer(app);
// const io = new Server(httpServer, { /* options */ });

// app.get('/', (req, res) => {
//   res.send('Hello World!');
// });

// app.listen(argv.port); // implement --bind

// Start watching journal directories
//  - keep track of bytes read
//  - have a "buffer" if last data didn't end with newline (shouldn't be parsable JSON)?
