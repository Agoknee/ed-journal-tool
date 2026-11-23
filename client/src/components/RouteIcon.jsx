/**
 * The galaxy map's route symbol (as on its Destination panel): a large node, a line to a smaller
 * one, and a short spur up to the smallest. Used on the Spansh route buttons.
 */
export default function RouteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M6.5 16.5L17.5 12L13.5 4.5" fill="none" />
      <circle cx="6.5" cy="16.5" r="4.2" stroke="none" />
      <circle cx="17.5" cy="12" r="2.9" stroke="none" />
      <circle cx="13.5" cy="4.5" r="2.1" stroke="none" />
    </svg>
  );
}
