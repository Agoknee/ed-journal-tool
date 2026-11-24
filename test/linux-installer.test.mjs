import assert from 'node:assert/strict';
import test from 'node:test';
import { installerScript } from '../scripts/linux-installer.mjs';

const values = { APP_ID: 'ed-journal-tool', APP_NAME: "Bob's Tool", APP_VERSION: '1.2.3', APP_COMMENT: 'Reads $HOME `journals` "here"' };

test('linux installer: the placeholders are filled, values shell-quoted, and it ends with the payload marker', () => {
  const script = installerScript(values);
  assert.ok(script.startsWith('#!/bin/sh\n'));
  assert.ok(!script.includes('\r'), 'LF line endings only');
  assert.ok(!/@[A-Z_]+@/.test(script), 'no placeholder left');
  assert.ok(script.includes("APP_ID='ed-journal-tool'\n"));
  assert.ok(script.includes(`APP_NAME='Bob'\\''s Tool'\n`), 'a single quote is closed, escaped and reopened');
  assert.ok(script.includes(`APP_COMMENT='Reads $HOME \`journals\` "here"'\n`), 'nothing expands inside single quotes');
  assert.ok(script.includes('# Bob\'s Tool 1.2.3 installer for Linux'), 'comments get the plain value');
  assert.ok(script.includes('sh ed-journal-tool-1.2.3-linux-x64-install.sh --service'));
  assert.ok(script.endsWith('\n__EDJT_PAYLOAD_BELOW__\n'));
});

test('linux installer: a value with a line break is refused', () => {
  assert.throws(() => installerScript({ ...values, APP_COMMENT: 'two\nlines' }), /line break/);
});
