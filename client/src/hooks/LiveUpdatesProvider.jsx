import { useEffect, useRef, useState } from 'react';
import { LiveUpdatesContext } from './live-updates-context.js';

/** Refreshes are throttled so a busy play session doesn't refetch on every journal line. */
const REFRESH_THROTTLE_MS = 1500;
const UPDATE_TOPICS = ['journals', 'stats', 'scan', 'statsBuild', 'compression', 'clock', 'notes', 'ticks', 'adjustments', 'shipStatus'];
/** Topics that are only progress to show, with nothing to refetch. */
const PROGRESS_TOPICS = new Set(['statsBuild', 'compression']);

/**
 * Subscribes to the server's event stream (/api/events) and exposes a version counter per topic.
 * Data hooks include these counters in their dependencies, so they refetch when data changes.
 * A "stats" update also bumps "stats:<module>" for each module it names (the modules that changed
 * and those that read from them), so stats requests can refetch only for their own module.
 */
export function LiveUpdatesProvider({ children }) {
  const [versions, setVersions] = useState({});
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [scanProgress, setScanProgress] = useState(null);
  const [statsBuildProgress, setStatsBuildProgress] = useState(null);
  const [compressionProgress, setCompressionProgress] = useState(null);
  const pendingTopicsRef = useRef(new Set());
  const throttleTimerRef = useRef(null);

  useEffect(() => {
    const eventSource = new EventSource('/api/events');

    const flushPendingTopics = () => {
      throttleTimerRef.current = null;
      const changedTopics = [...pendingTopicsRef.current];
      pendingTopicsRef.current.clear();
      setVersions((currentVersions) => {
        const nextVersions = { ...currentVersions };
        for (const topic of changedTopics) nextVersions[topic] = (nextVersions[topic] ?? 0) + 1;
        return nextVersions;
      });
    };

    const handleUpdate = (messageEvent) => {
      const update = JSON.parse(messageEvent.data);
      setLastUpdate(update);
      if (update.topic === 'scan') setScanProgress(update.payload);
      // Progress is shown as it comes, not throttled like the refreshes.
      if (update.topic === 'statsBuild') setStatsBuildProgress(update.payload);
      if (update.topic === 'compression') setCompressionProgress(update.payload);
      if (PROGRESS_TOPICS.has(update.topic)) return;

      pendingTopicsRef.current.add(update.topic);
      if (update.topic === 'stats') {
        for (const moduleName of update.payload?.modules ?? []) pendingTopicsRef.current.add(`stats:${moduleName}`);
      }
      throttleTimerRef.current ??= setTimeout(flushPendingTopics, REFRESH_THROTTLE_MS);
    };

    eventSource.addEventListener('open', () => setIsConnected(true));
    eventSource.addEventListener('error', () => setIsConnected(false));
    for (const topic of UPDATE_TOPICS) eventSource.addEventListener(topic, handleUpdate);

    return () => {
      eventSource.close();
      clearTimeout(throttleTimerRef.current);
    };
  }, []);

  return (
    <LiveUpdatesContext.Provider value={{ versions, isConnected, lastUpdate, scanProgress, statsBuildProgress, compressionProgress }}>
      {children}
    </LiveUpdatesContext.Provider>
  );
}
