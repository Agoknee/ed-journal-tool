/** Wing mission marker after the game's: a blue ring with a dark core and three blue circles centred on the ring. */
export function WingIcon() {
  return (
    <svg className="mission-wing-icon" viewBox="0 0 24 24" role="img" aria-label="Wing mission">
      <title>Wing mission</title>
      <circle className="mission-wing-icon-outline" cx="12" cy="13" r="9.1" />
      <circle className="mission-wing-icon-ring" cx="12" cy="13" r="7.7" />
      <circle className="mission-wing-icon-core" cx="12" cy="13" r="5" />
      <circle className="mission-wing-icon-ship" cx="12" cy="5.3" r="4" />
      <circle className="mission-wing-icon-ship" cx="5.33" cy="16.85" r="4" />
      <circle className="mission-wing-icon-ship" cx="18.67" cy="16.85" r="4" />
    </svg>
  );
}
