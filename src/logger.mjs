/**
 * Minimal console logger. Debug messages only print when debug mode is enabled.
 */
let isDebugEnabled = false;

function timestampPrefix() {
  return new Date().toLocaleTimeString();
}

export const logger = {
  setDebug(enabled) {
    isDebugEnabled = Boolean(enabled);
  },

  get isDebugEnabled() {
    return isDebugEnabled;
  },

  info(...messageParts) {
    console.log(`[${timestampPrefix()}]`, ...messageParts);
  },

  warn(...messageParts) {
    console.warn(`[${timestampPrefix()}] WARN:`, ...messageParts);
  },

  error(...messageParts) {
    console.error(`[${timestampPrefix()}] ERROR:`, ...messageParts);
  },

  debug(...messageParts) {
    if (isDebugEnabled) console.log(`[${timestampPrefix()}] DEBUG:`, ...messageParts);
  },
};
