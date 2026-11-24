import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openBackgroundLog } from '../src/windows/background.mjs';

test('background log: its folder is created on a new system, and the last run\'s log is kept', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'edjt-log-'));
  try {
    // A data folder that doesn't exist yet, two levels down.
    const logPath = path.join(root, 'AppData', 'edjt', 'edjt.log');
    const first = openBackgroundLog(logPath);
    writeSync(first, 'first run\n');
    closeSync(first);
    assert.equal(readFileSync(logPath, 'utf8'), 'first run\n');

    const second = openBackgroundLog(logPath);
    writeSync(second, 'second run\n');
    closeSync(second);
    assert.equal(readFileSync(logPath, 'utf8'), 'second run\n');
    assert.equal(readFileSync(path.join(root, 'AppData', 'edjt', 'edjt.previous.log'), 'utf8'), 'first run\n');
    assert.ok(existsSync(logPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
