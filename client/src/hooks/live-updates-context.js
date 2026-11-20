import { createContext, useContext } from 'react';

export const LiveUpdatesContext = createContext({ versions: {}, isConnected: false, lastUpdate: null, scanProgress: null });

/** Live update state: per-topic version counters, connection status and the latest scan progress. */
export function useLiveUpdates() {
  return useContext(LiveUpdatesContext);
}
