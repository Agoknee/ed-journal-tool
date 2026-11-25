/**
 * Small helpers for calling the server API.
 */

/** Sent on window when the API asks for a login (from another device, its session having ended). */
export const AUTH_REQUIRED_EVENT = 'edjt:auth-required';

/** Builds "?a=1&b=2" from an object, skipping empty values. */
export function buildQueryString(params = {}) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    searchParams.set(key, String(value));
  }
  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : '';
}

/**
 * EDJT couldn't be reached: it isn't running, it's restarting, or this device can't connect to it.
 * Shown as such (the connection banner explains), not as the browser's own "NetworkError…".
 */
export class UnreachableError extends Error {
  constructor() {
    super('Can’t reach EDJT right now. Is it running?');
    this.name = 'UnreachableError';
    this.isUnreachable = true;
  }
}

// What a proxy in front of EDJT (or Vite's, in development) answers when EDJT itself isn't there.
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Like fetchJson, also giving the response's size (characters of JSON), for the response cache.
 * @returns {Promise<{ data: any, size: number }>}
 */
export async function fetchJsonWithSize(path, { signal, method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new UnreachableError();
  }

  let text;
  try {
    text = await response.text();
  } catch {
    // The connection dropped part way (EDJT stopped while answering).
    throw new UnreachableError();
  }
  let responseData = {};
  try {
    responseData = text ? JSON.parse(text) : {};
  } catch {
    if (GATEWAY_STATUSES.has(response.status)) throw new UnreachableError();
    if (response.ok) throw new Error('EDJT sent something unexpected. Try reloading the page.');
  }
  if (responseData.code === 'auth-required' || responseData.code === 'remote-access-off') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!response.ok) {
    if (GATEWAY_STATUSES.has(response.status) && !responseData.error) throw new UnreachableError();
    throw new Error(responseData.error ?? `Request failed (${response.status})`);
  }
  return { data: responseData, size: text.length };
}

/**
 * Calls the API and returns its JSON. Throws an UnreachableError when EDJT can't be reached, and
 * an Error with EDJT's own message when it answers with one.
 */
export async function fetchJson(path, options) {
  return (await fetchJsonWithSize(path, options)).data;
}

export function postJson(path, body) {
  return fetchJson(path, { method: 'POST', body });
}

export function putJson(path, body) {
  return fetchJson(path, { method: 'PUT', body });
}

export function deleteJson(path) {
  return fetchJson(path, { method: 'DELETE' });
}
