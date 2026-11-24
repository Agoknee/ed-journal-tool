/**
 * Small helpers for calling the server API.
 */

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

export async function fetchJson(path, { signal, method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseData = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseData.error ?? `Request failed (${response.status})`);
  return responseData;
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
