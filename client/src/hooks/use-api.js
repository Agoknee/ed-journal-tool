import { useEffect, useState } from 'react';
import { buildQueryString, fetchJsonWithSize } from '../api.js';
import { useLiveUpdates } from './live-updates-context.js';

// How long a finished response is reused for another component asking for the same thing, so
// sections that mount together (or a moment apart) share one request.
const SHARED_RESULT_MS = 10 * 1000;
/** In-flight and recently finished requests by request key (URL plus refresh versions). */
const sharedRequests = new Map();

/**
 * The last response for each URL, kept so a section shows its data straight away when it's opened
 * again (then refreshes), and still has it while EDJT can't be reached. In memory only, for this
 * page, and limited by size: the least recently fetched go first.
 */
const MAX_CACHED_CHARACTERS = 8 * 1024 * 1024;
const lastResponses = new Map();
let cachedCharacters = 0;

function rememberResponse(requestUrl, data, size) {
  const previous = lastResponses.get(requestUrl);
  if (previous) {
    cachedCharacters -= previous.size;
    lastResponses.delete(requestUrl);
  }
  // A response bigger than a quarter of the cache isn't kept (it would push out everything else).
  if (size > MAX_CACHED_CHARACTERS / 4) return;
  lastResponses.set(requestUrl, { data, size });
  cachedCharacters += size;
  for (const [url, entry] of lastResponses) {
    if (cachedCharacters <= MAX_CACHED_CHARACTERS) break;
    lastResponses.delete(url);
    cachedCharacters -= entry.size;
  }
}

/**
 * Fetches a request, sharing it with every other caller using the same key while it's in flight
 * and for a short while after.
 */
function fetchShared(requestUrl, requestKey) {
  const shared = sharedRequests.get(requestKey);
  if (shared) return shared.promise;
  const entry = { promise: null };
  entry.promise = fetchJsonWithSize(requestUrl).then(({ data, size }) => {
    rememberResponse(requestUrl, data, size);
    return data;
  });
  sharedRequests.set(requestKey, entry);
  // Forgotten once it's no longer shared (lastResponses keeps the data), or straight away if it failed.
  entry.promise.then(
    () => setTimeout(() => { if (sharedRequests.get(requestKey) === entry) sharedRequests.delete(requestKey); }, SHARED_RESULT_MS),
    () => sharedRequests.delete(requestKey),
  );
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
 * While it loads, a URL fetched before (on this page) shows its last response straight away. When
 * a refresh fails, the last data for this URL stays, with the error beside it (isStale); an
 * UnreachableError (error.isUnreachable) means EDJT couldn't be reached.
 * @returns {{ data: any, error: Error | null, isLoading: boolean, isStale: boolean }}
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

  const [result, setResult] = useState({ requestUrl: null, requestKey: null, data: null, error: null });

  useEffect(() => {
    if (!requestUrl) return undefined;
    // A shared request can't be aborted for one caller; a superseded result is just ignored.
    let isCurrent = true;
    fetchShared(requestUrl, requestKey)
      .then((data) => {
        if (isCurrent) setResult({ requestUrl, requestKey, data, error: null });
      })
      .catch((error) => {
        if (!isCurrent) return;
        // Only this URL's data is kept: another's (a different commander, say) would be shown as this.
        setResult((previousResult) => ({
          requestUrl,
          requestKey,
          data: previousResult.requestUrl === requestUrl ? previousResult.data : (lastResponses.get(requestUrl)?.data ?? null),
          error,
        }));
      });
    return () => {
      isCurrent = false;
    };
  }, [requestUrl, requestKey]);

  // Until this URL's request finishes: its last response if there is one, otherwise what was shown
  // before (the previous parameters' data, as it's refetched).
  const data = result.requestUrl === requestUrl ? result.data : (lastResponses.get(requestUrl)?.data ?? result.data);
  const error = result.requestUrl === requestUrl ? result.error : null;
  return {
    data,
    error,
    isLoading: Boolean(requestKey) && result.requestKey !== requestKey,
    isStale: Boolean(error && data),
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
