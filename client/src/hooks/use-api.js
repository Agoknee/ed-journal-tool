import { useEffect, useState } from 'react';
import { buildQueryString, fetchJson } from '../api.js';
import { useLiveUpdates } from './live-updates-context.js';

// How long a finished response is reused for another component asking for the same thing, so
// sections that mount together (or a moment apart) share one request.
const SHARED_RESULT_MS = 10 * 1000;
const MAX_SHARED_RESULTS = 100;
/** In-flight and recently finished requests by request key (URL plus refresh versions). */
const sharedRequests = new Map();

/**
 * Fetches a request, sharing it with every other caller using the same key while it's in flight
 * and for a short while after.
 */
function fetchShared(requestUrl, requestKey) {
  const shared = sharedRequests.get(requestKey);
  if (shared && (!shared.finishedAt || Date.now() - shared.finishedAt < SHARED_RESULT_MS)) return shared.promise;
  const entry = { promise: null, finishedAt: null };
  entry.promise = fetchJson(requestUrl).finally(() => {
    entry.finishedAt = Date.now();
  });
  entry.promise.catch(() => sharedRequests.delete(requestKey));
  sharedRequests.set(requestKey, entry);
  // Keep the map small: drop the oldest entries.
  while (sharedRequests.size > MAX_SHARED_RESULTS) sharedRequests.delete(sharedRequests.keys().next().value);
  return entry.promise;
}

/**
 * The live update topic for a stats API path: "/api/stats/fleet/export" refreshes on
 * "stats:fleet", which the server announces when the fleet module (or one it reads from) changes.
 */
function getStatsTopic(path) {
  const match = /^\/api\/stats\/([a-z-]+)/.exec(path ?? '');
  return match ? `stats:${match[1]}` : null;
}

/**
 * Fetches JSON from the API and refetches when parameters change, when the server reports
 * changes on any of the given topics, or when live updates reconnect (the server restarted, say).
 * Previous data stays available while refetching.
 *
 * For stats paths, the "stats" topic narrows to the module the path belongs to, so a request only
 * refetches when its own data changed.
 * @param {string | null} path            API path, or null to skip fetching
 * @param {object} [params]               query string parameters
 * @param {string[]} [refreshTopics]      live update topics that should trigger a refetch
 * @returns {{ data: any, error: Error | null, isLoading: boolean }}
 */
export function useApi(path, params = {}, refreshTopics = ['stats']) {
  const { versions, reconnectCount } = useLiveUpdates();
  const requestUrl = path ? `${path}${buildQueryString(params)}` : null;
  const statsTopic = getStatsTopic(path);
  const topics = refreshTopics.map((topic) => (topic === 'stats' && statsTopic ? statsTopic : topic));
  // Also refetched whenever live updates reconnect, as changes announced meanwhile were missed. The
  // topic names are part of the key: requests for the same URL refreshing on different topics
  // mustn't share a result just because their counts happen to match ("clock" 1 isn't "scan" 1;
  // the clock warning would get a status fetched before the clock was checked).
  const refreshKey = [`reconnect=${reconnectCount}`, ...topics.map((topic) => `${topic}=${versions[topic] ?? 0}`)].join('&');
  const requestKey = requestUrl ? `${requestUrl}#${refreshKey}` : null;

  const [result, setResult] = useState({ requestKey: null, data: null, error: null });

  useEffect(() => {
    if (!requestUrl) return undefined;
    // A shared request can't be aborted for one caller; a superseded result is just ignored.
    let isCurrent = true;
    fetchShared(requestUrl, requestKey)
      .then((data) => {
        if (isCurrent) setResult({ requestKey, data, error: null });
      })
      .catch((error) => {
        if (isCurrent) setResult((previousResult) => ({ ...previousResult, requestKey, error }));
      });
    return () => {
      isCurrent = false;
    };
  }, [requestUrl, requestKey]);

  return {
    data: result.data,
    error: result.error,
    isLoading: Boolean(requestKey) && result.requestKey !== requestKey,
  };
}

/** Returns a value that only updates after it stops changing for the given delay. */
export function useDebouncedValue(value, delayMs = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const debounceTimer = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(debounceTimer);
  }, [value, delayMs]);
  return debouncedValue;
}
