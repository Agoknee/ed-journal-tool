import { useState } from 'react';

/**
 * Codecs for useStoredState: how a value is written to and read back from browser storage, where
 * everything is a string. parse returns undefined for a stored value that's no longer valid, so the
 * default is used instead.
 */
export const STORED_BOOLEAN = { parse: (raw) => raw === 'true', serialize: String };
export const STORED_STRING = { parse: (raw) => raw, serialize: String };
export const STORED_ID = {
  parse: (raw) => {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  },
  serialize: String,
};

/** A codec for one of a fixed set of string choices. */
export function storedChoice(choices) {
  return { parse: (raw) => (choices.includes(raw) ? raw : undefined), serialize: String };
}

/**
 * State that's remembered in this browser (localStorage) under a key, for per-viewer preferences
 * like a ticked checkbox or the commander picked. Storage can be unavailable (private windows,
 * blocked site data); the value then still works for the visit, it just isn't remembered.
 * @returns {[any, (value: any) => void]}
 */
export function useStoredState(storageKey, defaultValue, codec = STORED_STRING) {
  const [value, setValue] = useState(() => readStoredValue(storageKey, defaultValue, codec));
  const setAndStore = (nextValue) => {
    setValue(nextValue);
    try {
      localStorage.setItem(storageKey, codec.serialize(nextValue));
    } catch {
      // Not remembered; the value still applies until the page is reloaded.
    }
  };
  return [value, setAndStore];
}

function readStoredValue(storageKey, defaultValue, codec) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return defaultValue;
    return codec.parse(raw) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}
