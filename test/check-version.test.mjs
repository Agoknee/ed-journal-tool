import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, parseVersion } from '../scripts/check-version.mjs';

const compare = (a, b) => Math.sign(compareVersions(parseVersion(a), parseVersion(b)));

test('versions compare in semver order', () => {
  assert.equal(compare('0.2.1', '0.2.0'), 1);
  assert.equal(compare('0.10.0', '0.9.9'), 1);
  assert.equal(compare('1.0.0', 'v1.0.0'), 0);
  assert.equal(compare('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compare('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compare('1.0.0-beta', '1.0.0-alpha'), 1);
  assert.equal(compare('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compare('1.0.0+build.5', '1.0.0'), 0);
});

test('only versions parse', () => {
  assert.equal(parseVersion('v-nightly'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { numbers: [1, 2, 3], prerelease: ['rc', '1'] });
});
