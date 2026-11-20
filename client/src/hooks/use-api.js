import { useEffect, useState } from 'react';
import { buildQueryString, fetchJson } from '../api.js';
import { useLiveUpdates } from './live-updates-context.js';

/**
 * Fetches JSON from the API and refetches when parameters change or when the server
 * reports changes on any of the given topics. Previous data stays available while refetching.
 * @param {string | null} path            API path, or null to skip fetching
 * @param {object} [params]               query string parameters
 * @param {string[]} [refreshTopics]      live update topics that should trigger a refetch
 * @returns {{ data: any, error: Error | null, isLoading: boolean }}
 */
export function useApi(path, params = {}, refreshTopics = ['stats']) {
  const { versions } = useLiveUpdates();
  const requestUrl = path ? `${path}${buildQueryString(params)}` : null;
  const refreshKey = refreshTopics.map((topic) => versions[topic] ?? 0).join(':');
  const requestKey = requestUrl ? `${requestUrl}#${refreshKey}` : null;

  const [result, setResult] = useState({ requestKey: null, data: null, error: null });

  useEffect(() => {
    if (!requestUrl) return undefined;
    const abortController = new AbortController();

    fetchJson(requestUrl, { signal: abortController.signal })
      .then((data) => setResult({ requestKey, data, error: null }))
      .catch((error) => {
        if (error.name !== 'AbortError') setResult((previousResult) => ({ ...previousResult, requestKey, error }));
      });

    return () => abortController.abort();
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
