import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SettingsStore } from '../src/settings/settings-store.mjs';

const definitions = {
  refreshSeconds: { default: 30, validate: (value) => (Number.isInteger(value) && value >= 5 ? null : 'At least 5 seconds.') },
};

test('settings: defaults, checked changes, and kept in the file across restarts', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'edjt-settings-'));
  const filePath = path.join(directory, 'settings.json');
  try {
    const settings = new SettingsStore({ filePath, definitions });
    assert.deepEqual(settings.getSettings(), { refreshSeconds: 30 });

    assert.deepEqual(settings.updateSettings({ refreshSeconds: 2 }).errors, { refreshSeconds: 'At least 5 seconds.' });
    assert.deepEqual(settings.updateSettings({ unknown: 1, refreshSeconds: 10 }).errors, { unknown: 'There is no such setting.' });
    assert.deepEqual(settings.getSettings(), { refreshSeconds: 30 }, 'nothing changes when anything is wrong');

    assert.deepEqual(settings.updateSettings({ refreshSeconds: 10 }).settings, { refreshSeconds: 10 });
    settings.setInternal({ sessionKey: 'abc' });

    const reopened = new SettingsStore({ filePath, definitions });
    assert.deepEqual(reopened.getSettings(), { refreshSeconds: 10 });
    assert.equal(reopened.getInternal('sessionKey'), 'abc');
    reopened.setInternal({ sessionKey: undefined });
    assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).internal.sessionKey, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('settings: a damaged file means the defaults, and is left alone until something changes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'edjt-settings-'));
  const filePath = path.join(directory, 'settings.json');
  try {
    writeFileSync(filePath, '{ not json');
    const settings = new SettingsStore({ filePath, definitions });
    assert.deepEqual(settings.getSettings(), { refreshSeconds: 30 });
    assert.equal(readFileSync(filePath, 'utf8'), '{ not json');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
