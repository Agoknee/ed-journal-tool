/**
 * Space-themed 24px icons for the sidebar, drawn in the link's current text color. Shapes with the
 * "nav-icon-fill" class get a soft tint of that color so the icons read as more than outlines.
 */
const ICON_PATHS = {
  // Astronaut: round helmet with a visor and glint, suited shoulders and a chest control panel
  commanders: (
    <>
      <path className="nav-icon-fill" d="M3.5 22v-1.5A5.5 5.5 0 0 1 9 15h6a5.5 5.5 0 0 1 5.5 5.5V22" />
      <circle className="nav-icon-fill" cx="12" cy="8.5" r="6" />
      <path d="M7.8 8.5c0-1.9 1.9-2.8 4.2-2.8s4.2.9 4.2 2.8-1.9 3-4.2 3-4.2-1.1-4.2-3z" />
      <path d="M13.6 7.1l.9.5" />
      <rect x="10" y="17.5" width="4" height="2.5" rx="0.5" />
    </>
  ),
  // Capital ship from above, flying up and to the right: landing pads on the deck, engine pods and thrust
  carriers: (
    <g transform="rotate(45 12 12)">
      <path className="nav-icon-fill" d="M12 1.5l3.5 4.5v11l3 3v2.5h-13V20l3-3V6z" />
      <rect x="10.5" y="7.5" width="3" height="3" rx="0.4" />
      <rect x="10.5" y="12.5" width="3" height="3" rx="0.4" />
      <path d="M10 22v1.5M14 22v1.5" />
    </g>
  ),
  // Ringed planet with a ship streaking past
  travel: (
    <>
      <circle className="nav-icon-fill" cx="10" cy="13" r="5" />
      <path d="M3.4 16.2c-1.3 1.7-1.6 3-.8 3.6 1.6 1.2 6.4-1.3 10.8-5.5s7.2-8.6 5.9-9.9c-.6-.6-2-.3-3.8.9" />
      <path d="M17 3l1 2.2 2.2 1-2.2 1L17 9.4l-1-2.2-2.2-1 2.2-1z" />
    </>
  ),
  // One large gold coin with a bold dollar sign
  trade: (
    <>
      <circle className="nav-icon-fill" cx="12" cy="12" r="9.5" />
      <path d="M15.5 8H11a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H8.5M12 5.5V8M12 16v2.5" strokeWidth="2" />
    </>
  ),
  // Fuel pump with its display, hose and nozzle
  depots: (
    <>
      <rect className="nav-icon-fill" x="3.5" y="3" width="10.5" height="18" rx="1.5" />
      <rect x="6" y="5.5" width="5.5" height="4" rx="0.5" />
      <path d="M2 21h13.5" />
      <path d="M14 9h2a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0V7.5L18 5" />
    </>
  ),
  // Mission data pad: a clipboard with a checklist, the top task ticked
  missions: (
    <>
      <rect className="nav-icon-fill" x="4.5" y="3.5" width="15" height="18" rx="2" />
      <path d="M9 2.5h6v2.5H9z" />
      <path d="M7.5 9.5l1.3 1.3 2.2-2.6" />
      <path d="M13 9.5h3.5M7.5 14h2M13 14h3.5M7.5 18h2M13 18h3.5" />
    </>
  ),
  // Influence pie: the factions' shares of a system, one slice pulled out
  bgs: (
    <>
      <path className="nav-icon-fill" d="M11 3.5a8.5 8.5 0 1 0 8.5 8.5H11z" />
      <path d="M14 1.5a8.5 8.5 0 0 1 8.5 8.5H14z" />
    </>
  ),
  // Targeting reticle: outer ring, inner ring, crosshair ticks and a center dot
  combat: (
    <>
      <circle className="nav-icon-fill" cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </>
  ),
  // Comms satellite sending a signal
  chat: (
    <>
      <g transform="rotate(45 11 13)">
        <circle className="nav-icon-fill" cx="11" cy="13" r="2.5" />
        <rect className="nav-icon-fill" x="0.5" y="10" width="5.5" height="6" rx="0.5" />
        <rect className="nav-icon-fill" x="16" y="10" width="5.5" height="6" rx="0.5" />
        <path d="M3.25 10v6M18.75 10v6" />
        <path d="M6 13h2.5M13.5 13H16" />
      </g>
      <path d="M15 5.5a3.5 3.5 0 0 1 3.5 3.5" />
      <path d="M15 2a7 7 0 0 1 7 7" />
    </>
  ),
};

export default function NavIcon({ name }) {
  const iconPaths = ICON_PATHS[name];
  if (!iconPaths) return null;
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths}
    </svg>
  );
}
