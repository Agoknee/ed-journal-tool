import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureInaraAssets, listInaraAssets } from '../src/assets/inara-assets.mjs';

const quiet = { info() {}, warn() {} };
const assets = [
  { file: 'ranks/1-0.png', url: 'https://inara.example/ranks/1/0.png' },
  { file: 'powers/2.jpg', url: 'https://inara.example/powers/2.jpg' },
  { file: 'fonts/icons.woff2', url: 'https://inara.example/fonts/icons.woff2' },
];
const contentTypes = { png: 'image/png', jpg: 'image/jpeg', woff2: 'font/woff2' };

/** A stand-in for fetch: answers each URL with its own bytes, or as told. */
function fakeFetch({ fail = () => null } = {}) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const failure = fail(url);
    if (failure === 'network') throw new TypeError('fetch failed');
    if (failure === 'html') return new Response('<html>not found</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (failure) return new Response('', { status: failure });
    return new Response(`bytes of ${url}`, { status: 200, headers: { 'content-type': contentTypes[url.split('.').pop()] } });
  };
  return { fetchImpl, requested };
}

test('inara assets: the list covers every rank, navy, power and engineer image and the icon font', () => {
  const files = listInaraAssets().map((asset) => asset.file);
  assert.equal(files.length, 137);
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.includes('ranks/6-13.png') && files.includes('ranks/12-0.png') && files.includes('engineers/38.jpg') && files.includes('fonts/fontello.woff2'));
  assert.ok(listInaraAssets().every((asset) => asset.url.startsWith('https://inara.cz/')));
});

test('inara assets: only missing files are downloaded, and a later run downloads nothing', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'edjt-inara-'));
  try {
    mkdirSync(path.join(directory, 'ranks'));
    writeFileSync(path.join(directory, 'ranks/1-0.png'), 'already here');
    const first = fakeFetch();
    const result = await ensureInaraAssets({ directory, assets, fetchImpl: first.fetchImpl, log: quiet });
    assert.equal(result.downloaded, 2);
    assert.deepEqual(first.requested.sort(), ['https://inara.example/fonts/icons.woff2', 'https://inara.example/powers/2.jpg']);
    assert.equal(readFileSync(path.join(directory, 'powers/2.jpg'), 'utf8'), 'bytes of https://inara.example/powers/2.jpg');
    assert.equal(readFileSync(path.join(directory, 'ranks/1-0.png'), 'utf8'), 'already here');

    const second = fakeFetch();
    assert.equal((await ensureInaraAssets({ directory, assets, fetchImpl: second.fetchImpl, log: quiet })).downloaded, 0);
    assert.deepEqual(second.requested, []);
    assert.ok(!readdirSync(path.join(directory, 'powers')).some((file) => file.endsWith('.partial')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inara assets: with Inara unreachable it stops after the first file, and a bad response is never saved', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'edjt-inara-'));
  try {
    const offline = fakeFetch({ fail: () => 'network' });
    const result = await ensureInaraAssets({ directory, assets, fetchImpl: offline.fetchImpl, log: quiet });
    assert.equal(result.isUnreachable, true);
    assert.equal(new Set(offline.requested).size, 1, 'only the first file was tried');
    assert.equal(result.downloaded, 0);

    // An HTML page or an error status isn't an image: not saved, reported, and the rest still come.
    const partly = fakeFetch({ fail: (url) => (url.endsWith('.jpg') ? 'html' : url.endsWith('.woff2') ? 404 : null) });
    const partial = await ensureInaraAssets({ directory, assets, fetchImpl: partly.fetchImpl, log: quiet });
    assert.equal(partial.downloaded, 1);
    assert.deepEqual(partial.failed.map((failure) => failure.file).sort(), ['fonts/icons.woff2', 'powers/2.jpg']);
    assert.ok(existsSync(path.join(directory, 'ranks/1-0.png')));
    assert.ok(!existsSync(path.join(directory, 'powers/2.jpg')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
