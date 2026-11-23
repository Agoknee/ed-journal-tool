import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, event, sessionStart } from './helpers/journal-fixture.mjs';

test('fixture ingests a journal and serves stats', async () => {
  const fixture = await createFixture();
  try {
    fixture.writeJournal([...sessionStart({ credits: 5000 }), event('Shutdown', {}, '2026-01-01T01:00:00Z')]);
    await fixture.build();
    const { status, body } = await fixture.get(`/api/stats/credits?commander=${fixture.commanderId()}`);
    assert.equal(status, 200);
    assert.equal(body.balance.balance, 5000);
  } finally {
    await fixture.close();
  }
});
