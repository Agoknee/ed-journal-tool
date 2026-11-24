/**
 * Passwords for using the dashboard from other devices. On the computer running EDJT (localhost)
 * nothing is asked; anywhere else the API needs a session, from logging in with the password set on
 * the Settings page. With no password set, other devices can't use it at all.
 *
 * - Local means both: the request came over loopback, and was addressed to localhost, 127.0.0.1 or
 *   [::1]. A web page can't then pass itself off as local by pointing a name of its own at
 *   127.0.0.1 (DNS rebinding).
 * - The password is stored as an scrypt hash. A login gets a session cookie for 30 days (HttpOnly,
 *   SameSite=Strict), signed with a key kept with the settings; changing or removing the password
 *   makes a new key, logging every device out.
 * - After 5 wrong passwords from an address, logins from it are refused for a minute.
 * - Requests that change something (not GET) from another website are refused, whoever sends them.
 *
 * The dashboard's own files aren't protected (they hold no data); /api is, apart from /api/auth.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { logger } from '../logger.mjs';

const scryptAsync = promisify(scrypt);

const SESSION_COOKIE = 'edjt_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD_LENGTH = 8;
const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCKOUT_MS = 60 * 1000;
const SCRYPT_PARAMETERS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEY_LENGTH = 64;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a request comes from this computer, addressed to it by a local name (see above). */
export function isLocalRequest(request) {
  if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress)) return false;
  const hostName = String(request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOST_NAMES.has(hostName);
}

/** An scrypt hash of a password, with its salt and parameters, for storing. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_PARAMETERS);
  return { algorithm: 'scrypt', ...SCRYPT_PARAMETERS, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/** Whether a password matches a stored hash. */
export async function verifyPassword(password, stored) {
  if (stored?.algorithm !== 'scrypt' || typeof password !== 'string') return false;
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(stored.salt, 'base64'), expected.length, { N: stored.N, r: stored.r, p: stored.p });
  return timingSafeEqual(actual, expected);
}

function sign(value, key) {
  return createHmac('sha256', Buffer.from(key, 'base64')).update(value).digest('base64url');
}

/** A session token: when it expires, a random part, and their signature. */
function createSessionToken(key, now = Date.now()) {
  const value = `${now + SESSION_DAYS * 24 * 60 * 60 * 1000}.${randomBytes(12).toString('base64url')}`;
  return `${value}.${sign(value, key)}`;
}

function isValidSessionToken(token, key, now = Date.now()) {
  if (!key || typeof token !== 'string') return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return false;
  const value = token.slice(0, lastDot);
  const expected = Buffer.from(sign(value, key));
  const actual = Buffer.from(token.slice(lastDot + 1));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  return Number(value.split('.')[0]) > now;
}

function readCookie(request, name) {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function setSessionCookie(request, response, token) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: request.secure,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(request, response) {
  response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: request.secure, path: '/' });
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 1024) return 'The password is too long.';
  return null;
}

/**
 * The password checks for the API, and the routes for logging in and for settings.
 * @param {object} options
 * @param {import('../settings/settings-store.mjs').SettingsStore} options.settings
 * @param {(request: import('express').Request) => boolean} [options.isLocal]  (for tests)
 * @returns {{ protectApi: import('express').RequestHandler, refuseOtherSites: import('express').RequestHandler, authRouter: import('express').Router, settingsRouter: import('express').Router }}
 */
export function createAuth({ settings, isLocal = isLocalRequest }) {
  const failedLogins = new Map();
  const hasPassword = () => Boolean(settings.getInternal('passwordHash'));
  const hasSession = (request) => isValidSessionToken(readCookie(request, SESSION_COOKIE), settings.getInternal('sessionKey'));
  const isAuthenticated = (request) => isLocal(request) || (hasPassword() && hasSession(request));

  /** Saves a new password (or none), with a new session key, logging every device out. */
  async function savePassword(password) {
    settings.setInternal({
      passwordHash: password === null ? undefined : await hashPassword(password),
      sessionKey: password === null ? undefined : randomBytes(32).toString('base64'),
    });
  }

  /** Refuses requests that change something when they come from another website. */
  function refuseOtherSites(request, response, next) {
    const origin = request.headers.origin;
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS' || !origin) return next();
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Not a URL: refused below.
    }
    if (originHost && originHost === request.headers.host) return next();
    response.status(403).json({ error: 'Requests from other websites are refused.', code: 'other-site' });
  }

  /** Lets local requests and logged-in sessions through; /api/auth is always open. */
  function protectApi(request, response, next) {
    if (request.path === '/auth' || request.path.startsWith('/auth/') || isAuthenticated(request)) return next();
    if (!hasPassword()) {
      response.status(403).json({ error: 'Using EDJT from other devices is off until a password is set in Settings, on the computer running it.', code: 'remote-access-off' });
      return;
    }
    response.status(401).json({ error: 'Log in to continue.', code: 'auth-required' });
  }

  const authRouter = express.Router();

  // GET /api/auth/status -> whether this request needs a password, and has one
  authRouter.get('/status', (request, response) => {
    response.json({ isLocal: isLocal(request), hasPassword: hasPassword(), isAuthenticated: isAuthenticated(request) });
  });

  // POST /api/auth/login { password } -> a session cookie
  authRouter.post('/login', async (request, response) => {
    const address = request.socket.remoteAddress;
    const failures = failedLogins.get(address);
    if (failures?.lockedUntil > Date.now()) {
      response.status(429).json({ error: 'Too many wrong passwords. Try again in a minute.' });
      return;
    }
    if (!hasPassword()) {
      response.status(403).json({ error: 'No password is set. Set one in Settings, on the computer running EDJT.', code: 'remote-access-off' });
      return;
    }
    if (!(await verifyPassword(request.body?.password, settings.getInternal('passwordHash')))) {
      const count = (failures?.count ?? 0) + 1;
      failedLogins.set(address, count >= MAX_FAILED_LOGINS ? { count: 0, lockedUntil: Date.now() + LOGIN_LOCKOUT_MS } : { count, lockedUntil: 0 });
      if (count >= MAX_FAILED_LOGINS) logger.warn(`${MAX_FAILED_LOGINS} wrong dashboard passwords from ${address}; its logins are refused for a minute.`);
      response.status(401).json({ error: 'Wrong password.' });
      return;
    }
    failedLogins.delete(address);
    setSessionCookie(request, response, createSessionToken(settings.getInternal('sessionKey')));
    logger.info(`Dashboard login from ${address}.`);
    response.json({ isAuthenticated: true });
  });

  // POST /api/auth/logout
  authRouter.post('/logout', (request, response) => {
    clearSessionCookie(request, response);
    response.json({ isAuthenticated: isLocal(request) });
  });

  // Behind protectApi: only local requests and logged-in sessions get here.
  const settingsRouter = express.Router();

  // GET /api/settings -> the Settings page's settings, and the password's state
  settingsRouter.get('/', (request, response) => {
    response.json({ settings: settings.getSettings(), hasPassword: hasPassword(), isLocal: isLocal(request) });
  });

  // PATCH /api/settings { key: value, ... }
  settingsRouter.patch('/', (request, response) => {
    const result = settings.updateSettings(request.body);
    if (result.errors) {
      response.status(400).json({ error: Object.values(result.errors).join(' '), errors: result.errors });
      return;
    }
    response.json({ settings: result.settings });
  });

  /**
   * Changing or removing the password: from another device, only with the current one. (On this
   * computer it isn't asked, as nothing else is.)
   */
  async function checkCurrentPassword(request, response) {
    if (isLocal(request) || !hasPassword()) return true;
    if (await verifyPassword(request.body?.currentPassword, settings.getInternal('passwordHash'))) return true;
    response.status(403).json({ error: 'The current password is wrong.' });
    return false;
  }

  // PUT /api/settings/password { newPassword, currentPassword? }
  settingsRouter.put('/password', async (request, response) => {
    const problem = passwordProblem(request.body?.newPassword);
    if (problem) {
      response.status(400).json({ error: problem });
      return;
    }
    if (!(await checkCurrentPassword(request, response))) return;
    await savePassword(request.body.newPassword);
    logger.info('The dashboard password was changed; other devices have to log in again.');
    // The device that changed it stays logged in.
    if (!isLocal(request)) setSessionCookie(request, response, createSessionToken(settings.getInternal('sessionKey')));
    response.json({ hasPassword: true });
  });

  // DELETE /api/settings/password { currentPassword? } -> other devices can't use EDJT any more
  settingsRouter.delete('/password', async (request, response) => {
    if (!(await checkCurrentPassword(request, response))) return;
    await savePassword(null);
    clearSessionCookie(request, response);
    logger.info('The dashboard password was removed; other devices can no longer use EDJT.');
    response.json({ hasPassword: false });
  });

  return { protectApi, refuseOtherSites, authRouter, settingsRouter, hasPassword };
}
