/**
 * The 3D galaxy map of the jumps the list's filters pick, with a time-lapse replay. Loaded only
 * when it's opened (three.js is most of its weight); the scene itself is in galaxy-scene.js.
 */
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, formatLightYears, formatNumber, formatSystemName } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';
import { storedChoice, useStoredState } from '../../hooks/use-stored-state.js';
import { COMMANDER_COLORS, GalaxyScene, JUMP_KIND_COLORS, JUMP_KIND_LABELS } from './galaxy-scene.js';
import { describeStarClass } from './star-classes.js';

const SPEEDS = ['0.25', '0.5', '1', '2', '4', '8', '16'];
const ACTIVITY_BINS = 160;
/** The game's calendar runs 1,286 years ahead. */
const GAME_YEAR_OFFSET = 1286;
const gameDateFormatter = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

export default function GalaxyMap({ params, commanderFilter }) {
  const mapRequest = useApi('/api/stats/travel/map', params);
  const frameRef = useRef(null);
  const viewportRef = useRef(null);
  const sceneRef = useRef(null);
  const dataKeyRef = useRef(null);
  const [sceneError] = useState(getWebGLProblem);
  const [progress, setProgress] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [activity, setActivity] = useState([]);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pace, setPace] = useStoredState('travel.map.pace', 'jumps', storedChoice(['jumps', 'time']));
  const [speed, setSpeed] = useStoredState('travel.map.speed', '1', storedChoice(SPEEDS));
  const [trailStyle, setTrailStyle] = useStoredState('travel.map.trails', 'trail', storedChoice(['trail', 'comet']));
  const [storedColorMode, setColorMode] = useStoredState('travel.map.colors', 'type', storedChoice(['type', 'commander']));
  const data = mapRequest.data;
  const commanderCount = data?.commanders.length ?? 0;
  const colorMode = commanderCount > 1 ? storedColorMode : 'type';

  // The scene lives as long as the map is open.
  useEffect(() => {
    if (sceneError) return undefined;
    const scene = new GalaxyScene(viewportRef.current, { onProgress: setProgress, onHover: setHovered });
    sceneRef.current = scene;
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [sceneError]);

  useEffect(() => { sceneRef.current?.setPace(pace); setActivity(sceneRef.current?.getActivity(ACTIVITY_BINS) ?? []); }, [pace]);
  useEffect(() => { sceneRef.current?.setSpeed(Number(speed)); }, [speed]);
  useEffect(() => { sceneRef.current?.setTrailStyle(trailStyle); }, [trailStyle]);
  useEffect(() => { sceneRef.current?.setColorMode(colorMode); }, [colorMode]);
  useEffect(() => { sceneRef.current?.setFollowing(isFollowing); }, [isFollowing]);

  // New data: the same filters again (a live update) keeps the view; other filters re-frame it.
  const dataKey = JSON.stringify(params);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !data) return;
    scene.setData(data, { isSameView: dataKeyRef.current === dataKey });
    dataKeyRef.current = dataKey;
    setActivity(scene.getActivity(ACTIVITY_BINS));
  }, [data, dataKey]);

  const scene = sceneRef.current;
  const togglePlay = () => (progress?.isPlaying ? scene?.pause() : scene?.play());
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else frameRef.current?.requestFullscreen?.();
  };
  const handleKeyDown = (keyEvent) => {
    if (keyEvent.target !== keyEvent.currentTarget && keyEvent.target.tagName !== 'CANVAS') return;
    if (keyEvent.key === ' ') {
      keyEvent.preventDefault();
      togglePlay();
    }
  };

  const end = progress?.end ?? 0;
  const fraction = end > 0 ? progress.position / end : 0;
  const maxActivity = Math.max(1, ...activity);
  const isEmpty = data && data.jumps.to.length === 0;

  return (
    <div ref={frameRef} className={isFullscreen ? 'galaxy-map galaxy-map-fullscreen' : 'galaxy-map'} tabIndex={-1} onKeyDown={handleKeyDown}>
      <div ref={viewportRef} className="galaxy-viewport" />

      {sceneError && <div className="galaxy-message">The map needs WebGL, which this browser can’t provide ({sceneError.message}).</div>}
      {!sceneError && !data && <div className="galaxy-message">{mapRequest.error ? `Couldn’t load the map: ${mapRequest.error.message}` : 'Plotting your travels…'}</div>}
      {!sceneError && isEmpty && <div className="galaxy-message">No jumps with known positions match these filters.</div>}

      {progress?.realTime && (
        <div className="galaxy-hud">
          <div className="galaxy-hud-date">{formatGameDate(progress.realTime)}</div>
          <div className="galaxy-hud-real">{formatDateTime(progress.realTime)}</div>
          <dl className="galaxy-hud-counters">
            <div><dt>Jumps</dt><dd>{formatNumber(progress.jumps)}</dd></div>
            <div><dt>Travelled</dt><dd>{formatLightYears(Math.round(progress.distance))}</dd></div>
            <div><dt>Systems</dt><dd>{formatNumber(progress.systems)}</dd></div>
            <div><dt>First visits</dt><dd>{formatNumber(progress.newSystems)}</dd></div>
          </dl>
        </div>
      )}

      <div className="galaxy-view-buttons">
        <button type="button" className="galaxy-button" onClick={() => scene?.fitToTravels()} title="Frame every system on the map">Fit travels</button>
        <button type="button" className="galaxy-button" onClick={() => { setIsFollowing(false); scene?.showGalaxy(); }} title="The whole Milky Way">Galaxy</button>
        <button type="button" className={isFollowing ? 'galaxy-button galaxy-button-on' : 'galaxy-button'} aria-pressed={isFollowing} onClick={() => setIsFollowing(!isFollowing)} title="Keep the camera on the commander as they travel">Follow</button>
        <button type="button" className="galaxy-button" onClick={toggleFullscreen} title={isFullscreen ? 'Leave full screen' : 'Full screen'}>{isFullscreen ? 'Exit full screen' : 'Full screen'}</button>
      </div>

      <Legend colorMode={colorMode} commanders={data?.commanders ?? []} />

      {hovered && <SystemTooltip system={hovered} />}

      <div className="galaxy-controls">
        <button type="button" className="galaxy-play" onClick={togglePlay} disabled={!end} aria-label={progress?.isPlaying ? 'Pause' : 'Play the time-lapse'} title={progress?.isPlaying ? 'Pause (space)' : 'Play the time-lapse (space)'}>
          {progress?.isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="galaxy-timeline">
          <svg className="galaxy-activity" viewBox={`0 0 ${ACTIVITY_BINS} 20`} preserveAspectRatio="none" aria-hidden="true">
            {activity.map((count, index) => (
              count > 0 && (
                <rect
                  key={index}
                  x={index + 0.1}
                  width={0.8}
                  y={20 - Math.max(1.5, (Math.sqrt(count) / Math.sqrt(maxActivity)) * 20)}
                  height={Math.max(1.5, (Math.sqrt(count) / Math.sqrt(maxActivity)) * 20)}
                  className={index / ACTIVITY_BINS <= fraction ? 'galaxy-activity-past' : 'galaxy-activity-future'}
                />
              )
            ))}
          </svg>
          <input
            type="range"
            className="galaxy-scrubber"
            min={0}
            max={1000}
            step={1}
            value={Math.round(fraction * 1000)}
            disabled={!end}
            aria-label="Replay position"
            onChange={(changeEvent) => {
              scene?.pause();
              scene?.seek((Number(changeEvent.target.value) / 1000) * end);
            }}
          />
        </div>
        <select value={speed} onChange={(changeEvent) => setSpeed(changeEvent.target.value)} aria-label="Replay speed" title="Replay speed: at 1×, the whole replay takes about a minute">
          {SPEEDS.map((value) => <option key={value} value={value}>{formatSpeed(value)}</option>)}
        </select>
        <select value={pace} onChange={(changeEvent) => setPace(changeEvent.target.value)} aria-label="Pacing" title="Every jump the same time, or by the clock (with the time between sessions shortened)">
          <option value="jumps">Steady pace</option>
          <option value="time">Real time</option>
        </select>
        <select value={trailStyle} onChange={(changeEvent) => setTrailStyle(changeEvent.target.value)} aria-label="Trails">
          <option value="trail">Full trails</option>
          <option value="comet">Comet trails</option>
        </select>
        {commanderCount > 1 && (
          <select value={colorMode} onChange={(changeEvent) => setColorMode(changeEvent.target.value)} aria-label="Colour trails by">
            <option value="type">Colour by jump type</option>
            <option value="commander">Colour by commander</option>
          </select>
        )}
      </div>

      {data?.isTruncated && (
        <div className="galaxy-note">Showing the latest {formatNumber(data.jumps.to.length)} of {formatNumber(data.total)} jumps; narrow the filters to see older ones.</div>
      )}
      {commanderFilter === 'all' && commanderCount > 1 && colorMode !== 'commander' && (
        <div className="galaxy-note galaxy-note-hint">Tip: colour by commander to tell {formatNumber(commanderCount)} commanders apart.</div>
      )}
    </div>
  );
}

function Legend({ colorMode, commanders }) {
  const items = colorMode === 'commander'
    ? commanders.map((commander, index) => ({ label: `CMDR ${commander.name}`, color: COMMANDER_COLORS[index % COMMANDER_COLORS.length] }))
    : JUMP_KIND_LABELS.map((label, index) => ({ label, color: JUMP_KIND_COLORS[index] }));
  return (
    <ul className="galaxy-legend">
      {items.map((item) => (
        <li key={item.label}><span className="galaxy-legend-swatch" style={{ background: item.color, boxShadow: `0 0 8px ${item.color}` }} />{item.label}</li>
      ))}
      <li className="galaxy-legend-hint">Stars are coloured by class · double-click one to fly there</li>
    </ul>
  );
}

function SystemTooltip({ system }) {
  const star = describeStarClass(system.starClass);
  return (
    <div className="galaxy-tooltip" style={{ transform: `translate(${Math.round(system.x + 14)}px, ${Math.round(system.y + 14)}px)` }}>
      <strong>{formatSystemName(system.name) ?? system.name}</strong>
      <div><span className="galaxy-legend-swatch" style={{ background: star.color }} /> {system.starClass ? star.name : 'Star not logged'}</div>
      <div className="muted">{system.visits > 0 ? `${formatNumber(system.visits)} ${system.visits === 1 ? 'arrival' : 'arrivals'}` : 'Jumped from'}</div>
      <div className="muted small">{formatNumber(system.x)} / {formatNumber(system.y)} / {formatNumber(system.z)}</div>
    </div>
  );
}

/** Why the map can't be drawn here (no WebGL 2), or null when it can. */
function getWebGLProblem() {
  try {
    const context = document.createElement('canvas').getContext('webgl2');
    if (context) {
      context.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    }
    return new Error('WebGL 2 is turned off or not supported');
  } catch (error) {
    return error;
  }
}

function formatGameDate(milliseconds) {
  const date = new Date(milliseconds);
  return `${gameDateFormatter.format(date).toUpperCase()} ${date.getUTCFullYear() + GAME_YEAR_OFFSET}`;
}

function formatSpeed(value) {
  return { 0.25: '¼×', 0.5: '½×' }[value] ?? `${value}×`;
}

function PlayIcon() {
  return <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>;
}

function PauseIcon() {
  return <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor" /></svg>;
}
