import { useEffect, useRef, useState } from 'react';
import { AUTH_REQUIRED_EVENT } from '../api.js';
import { LiveUpdatesContext } from './live-updates-context.js';

/** Refreshes are throttled so a busy play session doesn't refetch on every journal line. */
const REFRESH_THROTTLE_MS = 1500;
const UPDATE_TOPICS = ['journals', 'stats', 'scan', 'statsBuild', 'compression', 'clock', 'notes', 'ticks', 'adjustments', 'shipStatus'];
/** How long to wait before opening the stream again once the browser has given up on it. */
const REOPEN_DELAY_MS = 3000;
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
  // How many times the stream has come back after dropping (the server restarting, say). Every
  // request refetches when it changes (see useApi): anything announced while disconnected was
  // missed, such as the clock check soon after the server starts.
  const [reconnectCount, setReconnectCount] = useState(0);
  const pendingTopicsRef = useRef(new Set());
  const throttleTimerRef = useRef(null);

  useEffect(() => {
    let eventSource = null;
    let hasOpened = false;
    let reopenTimer = null;

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

    const handleOpen = () => {
      setIsConnected(true);
      // The first connection follows the page's own first requests; a later one follows a gap.
      if (hasOpened) {
        // Progress from before is stale (a restarted server's scan isn't the old one), so the
        // banners go back to what /api/status says, which refetches with everything else.
        setScanProgress(null);
        setStatsBuildProgress(null);
        setCompressionProgress(null);
        setReconnectCount((count) => count + 1);
      }
      hasOpened = true;
    };

    /**
     * The browser retries a dropped stream by itself, but gives up for good when it gets an answer
     * that isn't the stream (an error page while the server restarts, say). Then it's opened anew
     * after a few seconds, rather than staying "not running" until the page is reloaded. It may
     * also have been refused for want of a login (on another device whose session ended), so the
     * login is checked again too: the login screen then replaces the dashboard, ending this.
     */
    const handleError = () => {
      setIsConnected(false);
      if (eventSource.readyState !== EventSource.CLOSED || reopenTimer) return;
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
      reopenTimer = setTimeout(() => {
        reopenTimer = null;
        connect();
      }, REOPEN_DELAY_MS);
    };

    const connect = () => {
      eventSource?.close();
      eventSource = new EventSource('/api/events');
      eventSource.addEventListener('open', handleOpen);
      eventSource.addEventListener('error', handleError);
      for (const topic of UPDATE_TOPICS) eventSource.addEventListener(topic, handleUpdate);
    };
    connect();

    return () => {
      eventSource.close();
      clearTimeout(reopenTimer);
      clearTimeout(throttleTimerRef.current);
    };
  }, []);

  return (
    <LiveUpdatesContext.Provider value={{ versions, isConnected, lastUpdate, scanProgress, statsBuildProgress, compressionProgress, reconnectCount }}>
      {children}
    </LiveUpdatesContext.Provider>
  );
}
