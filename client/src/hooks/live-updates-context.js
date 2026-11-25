import { createContext, useContext } from 'react';

export const LiveUpdatesContext = createContext({ versions: {}, isConnected: false, disconnectedAt: null, isUnreachable: false, lastUpdate: null, scanProgress: null, statsBuildProgress: null, compressionProgress: null, reconnectCount: 0 });

/** Live update state: per-topic version counters, connection status and the latest scan progress. */
export function useLiveUpdates() {
  return useContext(LiveUpdatesContext);
}
