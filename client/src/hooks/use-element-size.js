import { useEffect, useState } from 'react';

/**
 * The size of an element's content box, kept up to date as it resizes. Pass the returned callback
 * ref to the element (it may appear later, e.g. after data loads); the size is { width: 0,
 * height: 0 } until it has been measured.
 * @returns {[(element: HTMLElement | null) => void, { width: number, height: number }]}
 */
export function useElementSize() {
  const [element, setElement] = useState(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size];
}
