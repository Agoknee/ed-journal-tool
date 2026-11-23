import { useEffect, useState } from 'react';

/**
 * The current time (ms), updated every intervalMs so countdowns and "time since" values stay
 * current. shouldRun(now) can pause the updates (e.g. once a countdown has finished).
 * @param {number} intervalMs
 * @param {(now: number) => boolean} [shouldRun]
 */
export function useNow(intervalMs, shouldRun = () => true) {
  const [now, setNow] = useState(() => Date.now());
  const isRunning = shouldRun(now);
  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, isRunning]);
  return now;
}
