import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createAuth, hashPassword, isLocalRequest, verifyPassword } from '../src/server/auth.mjs';
import { SettingsStore } from '../src/settings/settings-store.mjs';

/**
 * A server with the auth checks in front of a stand-in API route. Requests with an
 * "X-Test-Remote: 1" header count as coming from another device.
 */
async function startServer(settings) {
  const auth = createAuth({ settings, isLocal: (request) => request.headers['x-test-remote'] !== '1' });
  const app = express();
  app.use(express.json());
  app.use('/api', auth.refuseOtherSites, auth.protectApi);
  app.use('/api/auth', auth.authRouter);
  app.use('/api/settings', auth.settingsRouter);
  app.get('/api/data', (request, response) => response.json({ secret: 42 }));
  app.post('/api/data', (request, response) => response.json({ saved: true }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  /** Like a browser on another device: keeps the session cookie between requests. */
  function remoteClient() {
    let cookie = null;
    return async (apiPath, { method = 'GET', body, headers = {} } = {}) => {
      const response = await fetch(`${baseUrl}${apiPath}`, {
        method,
        headers: { 'X-Test-Remote': '1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? null : setCookie.split(';')[0];
      return { status: response.status, body: await response.json(), setCookie };
    };
  }
  const local = async (apiPath, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${apiPath}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { local, remoteClient, close: () => new Promise((resolve) => server.close(resolve)) };
}

function withSettings(run) {
  return async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'edjt-auth-'));
    const settings = new SettingsStore({ filePath: path.join(directory, 'settings.json'), definitions: {} });
    const server = await startServer(settings);
    try {
      await run({ server, settings, directory });
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('auth: this computer needs no password; other devices are refused until one is set', withSettings(async ({ server }) => {
  assert.equal((await server.local('/api/data')).status, 200);
  assert.deepEqual((await server.local('/api/auth/status')).body, { isLocal: true, hasPassword: false, isAuthenticated: true });

  const phone = server.remoteClient();
  const refused = await phone('/api/data');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'remote-access-off');
  assert.deepEqual((await phone('/api/auth/status')).body, { isLocal: false, hasPassword: false, isAuthenticated: false });
  assert.equal((await phone('/api/auth/login', { method: 'POST', body: { password: 'anything' } })).status, 403);
}));

test('auth: with a password, another device logs in, and changing it logs other devices out', withSettings(async ({ server, settings, directory }) => {
  assert.equal((await server.local('/api/settings/password', { method: 'PUT', body: { newPassword: 'short' } })).status, 400);
  assert.equal((await server.local('/api/settings/password', { method: 'PUT', body: { newPassword: 'correct horse' } })).status, 200);
  assert.equal((await server.local('/api/settings')).body.hasPassword, true);
  // The hash, never the password, is stored; and only for this user on Linux and macOS.
  assert.equal(JSON.stringify(settings.data).includes('correct horse'), false);
  if (process.platform !== 'win32') assert.equal(statSync(path.join(directory, 'settings.json')).mode & 0o777, 0o600);

  const phone = server.remoteClient();
  assert.equal((await phone('/api/data')).body.code, 'auth-required');
  assert.equal((await phone('/api/auth/login', { method: 'POST', body: { password: 'wrong password' } })).status, 401);
  const login = await phone('/api/auth/login', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal(login.status, 200);
  assert.match(login.setCookie, /HttpOnly/i);
  assert.match(login.setCookie, /SameSite=Strict/i);
  assert.deepEqual((await phone('/api/data')).body, { secret: 42 });

  // A second device logged in too, then the first changes the password: it stays in, the other is out.
  const tablet = server.remoteClient();
  await tablet('/api/auth/login', { method: 'POST', body: { password: 'correct horse' } });
  assert.equal((await phone('/api/settings/password', { method: 'PUT', body: { newPassword: 'battery staple', currentPassword: 'wrong' } })).status, 403);
  assert.equal((await phone('/api/settings/password', { method: 'PUT', body: { newPassword: 'battery staple', currentPassword: 'correct horse' } })).status, 200);
  assert.equal((await phone('/api/data')).status, 200);
  assert.equal((await tablet('/api/data')).status, 401);

  // Logging out ends the session.
  await phone('/api/auth/logout', { method: 'POST' });
  assert.equal((await phone('/api/data')).status, 401);

  // Removing the password (here, on this computer) shuts other devices out again.
  assert.equal((await server.local('/api/settings/password', { method: 'DELETE' })).status, 200);
  assert.equal((await tablet('/api/auth/login', { method: 'POST', body: { password: 'battery staple' } })).status, 403);
}));

test('auth: logins are refused for a while after 5 wrong passwords', withSettings(async ({ server }) => {
  await server.local('/api/settings/password', { method: 'PUT', body: { newPassword: 'correct horse' } });
  const phone = server.remoteClient();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await phone('/api/auth/login', { method: 'POST', body: { password: `guess ${attempt}` } })).status, 401);
  }
  assert.equal((await phone('/api/auth/login', { method: 'POST', body: { password: 'correct horse' } })).status, 429);
}));

test('auth: requests from other websites that change something are refused', withSettings(async ({ server }) => {
  assert.equal((await server.local('/api/data', { method: 'POST', body: {}, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await server.local('/api/data', { headers: { Origin: 'http://evil.example' } })).status, 200, 'reading is left to the browser\'s own rules');
  const sameSite = await server.local('/api/data', { method: 'POST', body: {}, headers: { Origin: 'http://127.0.0.1' } });
  assert.equal(sameSite.status, 403, 'another port is another site');
}));

test('auth: a request is local only over loopback and addressed to a local name', () => {
  const request = (remoteAddress, host) => ({ socket: { remoteAddress }, headers: { host } });
  assert.equal(isLocalRequest(request('127.0.0.1', 'localhost:4267')), true);
  assert.equal(isLocalRequest(request('::1', '[::1]:4267')), true);
  assert.equal(isLocalRequest(request('::ffff:127.0.0.1', '127.0.0.1:4267')), true);
  assert.equal(isLocalRequest(request('192.168.1.20', 'localhost:4267')), false, 'another device');
  assert.equal(isLocalRequest(request('127.0.0.1', 'rebound.example:4267')), false, 'a web page pointing its own name at 127.0.0.1');
  assert.equal(isLocalRequest(request('127.0.0.1', '192.168.1.5:4267')), false, 'this computer by its network address');
});

test('auth: passwords are checked against their scrypt hash', async () => {
  const stored = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('correct horsf', stored), false);
  assert.equal(await verifyPassword(undefined, stored), false);
  assert.notEqual((await hashPassword('correct horse')).salt, stored.salt, 'each hash has its own salt');
});
