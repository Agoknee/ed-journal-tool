import assert from 'node:assert/strict';
import { rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createJournalRoutes } from '../src/server/routes/journal-routes.mjs';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

test('a flagged journal’s raw lines are read from the journal folder when asked for', async () => {
  const fixture = await createFixture();
  const app = express();
  app.use('/api', createJournalRoutes(fixture.database, { journalDirectory: fixture.journalDirectory }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const get = async (apiPath) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${apiPath}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    // Two commanders in one file, a broken line, a line that isn't an entry and a blank line.
    const fileName = 'Journal.2026-06-01T000000.01.log';
    const lines = [
      ...sessionStart({ commander: 'ALPHA', fid: 'F1', at: '2026-06-01T00:00:00Z' }).map((entry) => JSON.stringify(entry)),
      '{"timestamp":"2026-06-01T00:00:05Z", "event":"Music", "MusicTr',
      '[1, 2, 3]',
      '',
      ...sessionStart({ commander: 'BRAVO', fid: 'F2', at: '2026-06-01T00:10:00Z' }).slice(1).map((entry) => JSON.stringify(entry)),
      JSON.stringify(event('Shutdown', {}, '2026-06-01T00:20:00Z')),
    ];
    const filePath = path.join(fixture.journalDirectory, fileName);
    writeFileSync(filePath, lines.join('\r\n') + '\r\n');
    const settled = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(filePath, settled, settled);
    await fixture.build();
    const { id: fileId, status } = fixture.database.prepare('SELECT id, status FROM journal_files WHERE file_name = ?').get(fileName);
    assert.equal(status, 'corrupt');

    const { status: httpStatus, body: raw } = await get(`/api/journals/${fileId}/raw?limit=100`);
    assert.equal(httpStatus, 200);
    assert.equal(raw.lineCount, lines.length);
    assert.equal(raw.total, lines.length);
    assert.equal(raw.problemCount, 2);
    assert.equal(raw.endsMidLine, false);
    assert.deepEqual(raw.rows.map((line) => line.text), lines, 'each line exactly as written, without its line ending');
    assert.deepEqual(raw.commanders, [
      { name: 'ALPHA', fid: 'F1', firstLine: 2, lineCount: 2 },
      { name: 'BRAVO', fid: 'F2', firstLine: 7, lineCount: 2 },
    ]);
    assert.match(raw.rows[3].problem, /^Not valid JSON/);
    assert.equal(raw.rows[4].problem, 'Not a journal entry (no "event" field)');
    assert.equal(raw.rows[5].problem, null, 'blank lines are skipped by the reader, not a problem');
    assert.equal(raw.rows[0].event, 'Fileheader');
    assert.equal(raw.rows[0].timestamp, '2026-06-01T00:00:00Z');

    const problems = (await get(`/api/journals/${fileId}/raw?filter=problems`)).body;
    assert.deepEqual(problems.rows.map((line) => line.line_number), [4, 5]);
    const commanderLines = (await get(`/api/journals/${fileId}/raw?filter=commanders`)).body;
    assert.deepEqual(commanderLines.rows.map((line) => line.line_number), [2, 3, 7, 8]);
    const searched = (await get(`/api/journals/${fileId}/raw?search=bravo`)).body;
    assert.deepEqual(searched.rows.map((line) => line.line_number), [7, 8]);
    const secondPage = (await get(`/api/journals/${fileId}/raw?limit=3&offset=3`)).body;
    assert.deepEqual(secondPage.rows.map((line) => line.line_number), [4, 5, 6]);
    assert.equal(secondPage.total, lines.length);

    // Read when asked: a line added since shows up, and a file that's gone says so.
    writeFileSync(filePath, lines.join('\r\n') + '\r\n{"timestamp":"2026-06-01T00:30:00Z", "event":"Mus');
    const reread = (await get(`/api/journals/${fileId}/raw?limit=100`)).body;
    assert.equal(reread.lineCount, lines.length + 1);
    assert.equal(reread.endsMidLine, true);
    rmSync(filePath);
    const missing = await get(`/api/journals/${fileId}/raw`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'The file is no longer in the journal folder.');
    assert.equal((await get('/api/journals/99999/raw')).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});

test('the raw view only reads known journals in the journal folder, never another file', async (context) => {
  const fixture = await createFixture();
  const app = express();
  app.use('/api', createJournalRoutes(fixture.database, { journalDirectory: fixture.journalDirectory }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const get = async (apiPath) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${apiPath}`);
    return { status: response.status, text: await response.text() };
  };
  // A file outside the journal folder whose contents must never come back.
  const secretPath = path.join(fixture.journalDirectory, '..', 'secret.txt');
  writeFileSync(secretPath, 'TOP-SECRET-CONTENTS\n');
  try {
    fixture.writeJournal([event('Fileheader', { part: 1 }, '2026-06-01T00:00:00Z')], { fileName: 'Journal.2026-06-01T000000.01.log' });
    await fixture.build();
    const fileId = fixture.database.prepare('SELECT id FROM journal_files').get().id;
    assert.equal((await get(`/api/journals/${fileId}/raw`)).status, 200);

    // Paths, encodings and odd ids in place of the file id.
    for (const attempt of ['..%2Fsecret.txt', '..%2F..%2Fsecret.txt', '%2E%2E%5Csecret.txt', 'secret.txt', '-1', '1e9', 'NaN', '%00']) {
      const { status, text } = await get(`/api/journals/${attempt}/raw`);
      assert.ok(status === 404, `${attempt}: ${status}`);
      assert.ok(!text.includes('TOP-SECRET'), attempt);
    }
    // Query parameters can't name a file.
    for (const query of ['path=../secret.txt', 'file=../secret.txt', 'fileName=../secret.txt', 'search=../secret.txt']) {
      assert.ok(!(await get(`/api/journals/${fileId}/raw?${query}`)).text.includes('TOP-SECRET'), query);
    }
    // Even a stored file name pointing elsewhere (the ingester only records real journal names) is refused.
    for (const storedName of ['../secret.txt', '..\\secret.txt', 'Journal.2026-06-01T000000.01.log/../../secret.txt', path.join(fixture.journalDirectory, '..', 'secret.txt')]) {
      fixture.database.prepare('UPDATE journal_files SET file_name = ? WHERE id = ?').run(storedName, fileId);
      const { status, text } = await get(`/api/journals/${fileId}/raw`);
      assert.equal(status, 404, storedName);
      assert.ok(!text.includes('TOP-SECRET'), storedName);
    }

    // A link named like a journal isn't followed, by the ingester or the raw view.
    const linkName = 'Journal.2026-06-02T000000.01.log';
    try {
      symlinkSync(secretPath, path.join(fixture.journalDirectory, linkName), 'file');
    } catch (error) {
      context.diagnostic(`symbolic link part skipped: ${error.code} (creating links needs Developer Mode or admin on Windows)`);
      return;
    }
    await fixture.ingester.processFile(linkName);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS n FROM journal_files WHERE file_name = ?').get(linkName).n, 0, 'the link was not read');
    fixture.database.prepare("INSERT INTO journal_files (file_name, sort_key, status) VALUES (?, 'x', 'corrupt')").run(linkName);
    const linkId = fixture.database.prepare('SELECT id FROM journal_files WHERE file_name = ?').get(linkName).id;
    const { status, text } = await get(`/api/journals/${linkId}/raw`);
    assert.equal(status, 404);
    assert.ok(!text.includes('TOP-SECRET'));
  } finally {
    rmSync(secretPath, { force: true });
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});
