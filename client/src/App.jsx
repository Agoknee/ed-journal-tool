import { Fragment, useEffect, useState } from 'react';
import { useLiveUpdates } from './hooks/live-updates-context.js';
import { useApi } from './hooks/use-api.js';
import { useStoredState } from './hooks/use-stored-state.js';
import { copyToClipboard } from './clipboard.js';
import { formatDateTime, formatRelativeTime } from './format.js';
import NavIcon from './components/NavIcon.jsx';
import BgsPage from './pages/BgsPage.jsx';
import CarriersPage from './pages/CarriersPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import CombatPage from './pages/CombatPage.jsx';
import CommandersPage from './pages/CommandersPage.jsx';
import TradePage from './pages/TradePage.jsx';
import TravelPage from './pages/TravelPage.jsx';
import DepotsPage from './pages/DepotsPage.jsx';
import JournalsPage from './pages/JournalsPage.jsx';
import MissionsPage from './pages/MissionsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';

// Sub-sections are listed under the active page in the sidebar. Each scrolls to the element with
// its targetId, or to the top of the page when there's none.
const PAGES = [
  {
    id: 'commanders',
    label: 'Commanders',
    component: CommandersPage,
    subSections: [
      { label: 'Overview' },
      { label: 'Fleet', targetId: 'commanders-fleet' },
      { label: 'Inventory', targetId: 'commanders-inventory' },
      { label: 'Ranks & Reputation', targetId: 'commanders-ranks' },
      { label: 'Credits', targetId: 'commanders-credits' },
      { label: 'Engineers', targetId: 'commanders-engineers' },
    ],
  },
  {
    id: 'carriers',
    label: 'Carriers',
    component: CarriersPage,
    subSections: [
      { label: 'Overview' },
      { label: 'Details', targetId: 'carrier-details' },
      { label: 'Jump History', targetId: 'carrier-jump-history' },
      { label: 'Bank History', targetId: 'carrier-bank-history' },
    ],
  },
  {
    id: 'travel',
    label: 'Travel',
    component: TravelPage,
    subSections: [
      { label: 'Overview' },
      { label: 'History', targetId: 'travel-history' },
    ],
  },
  {
    id: 'trade',
    label: 'Trade',
    component: TradePage,
    subSections: [
      { label: 'Overview' },
      { label: 'Commodities', targetId: 'trade-commodities' },
      { label: 'Markets', targetId: 'trade-markets' },
      { label: 'History', targetId: 'trade-history' },
    ],
  },
  {
    id: 'depots',
    label: 'Depots',
    component: DepotsPage,
    subSections: [
      { label: 'Overview' },
      { label: 'History', targetId: 'depot-history' },
    ],
  },
  {
    id: 'bgs',
    label: 'BGS',
    // Shown at the top of the page; the sidebar keeps the short label.
    title: 'Background Simulation',
    component: BgsPage,
    subSections: [
      { label: 'Activity' },
      { label: 'Tick History', targetId: 'bgs-tick-history' },
      { label: 'Manual Adjustments', targetId: 'bgs-adjustments' },
    ],
  },
  {
    id: 'missions',
    label: 'Missions',
    component: MissionsPage,
    subSections: [
      { label: 'Overview' },
      { label: 'Massacre Stacks', targetId: 'missions-massacre' },
      { label: 'Mining & Cargo', targetId: 'missions-cargo' },
      { label: 'History', targetId: 'missions-history' },
    ],
  },
  {
    id: 'combat',
    label: 'Combat',
    component: CombatPage,
    subSections: [
      { label: 'Overview' },
      { label: 'Kills Over Time', targetId: 'combat-timeline' },
      { label: 'When You Fight', targetId: 'combat-heatmap' },
      { label: 'Sessions', targetId: 'combat-sessions' },
      { label: 'Deaths', targetId: 'combat-deaths' },
      { label: 'Victims', targetId: 'combat-victims' },
    ],
  },
  { id: 'chat', label: 'Chat', component: ChatPage },
  { id: 'settings', label: 'Settings', component: SettingsPage, subSections: [{ label: 'Password' }, { label: 'Database', targetId: 'settings-database' }] },
  // Opened from the connection status at the bottom of the sidebar instead of the nav.
  { id: 'journals', label: 'Journals', component: JournalsPage, isHiddenFromNav: true },
];

const COMMANDER_STORAGE_KEY = 'selectedCommander';

function getPageIdFromHash() {
  const hashPageId = window.location.hash.replace('#/', '').replace('#', '');
  return PAGES.some((page) => page.id === hashPageId) ? hashPageId : PAGES[0].id;
}

// A sub-section counts as current once its heading has scrolled within this distance of the top.
const SUB_SECTION_ACTIVE_OFFSET_PX = 80;

/**
 * Index of the sub-section the page is scrolled to: the last one whose heading has reached the top.
 * At the very bottom of the page, the last heading that's on screen wins, since sections near the
 * end can't scroll up to the top.
 */
function findCurrentSubSectionIndex(subSections) {
  const isAtBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  const threshold = isAtBottom ? window.innerHeight : SUB_SECTION_ACTIVE_OFFSET_PX;
  let currentIndex = 0;
  subSections.forEach((subSection, index) => {
    const target = subSection.targetId && document.getElementById(subSection.targetId);
    if (target && target.getBoundingClientRect().top <= threshold) currentIndex = index;
  });
  return currentIndex;
}

/**
 * Tracks the current sub-section. It's re-checked after the page renders (so switching pages starts
 * fresh), on scroll and resize, and whenever the page's height changes as its data loads.
 */
function useCurrentSubSectionIndex(subSections) {
  const [currentIndex, setCurrentIndex] = useState(0);
  useEffect(() => {
    if (!subSections) return undefined;
    let frameId = null;
    const scheduleUpdate = () => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        setCurrentIndex(findCurrentSubSectionIndex(subSections));
      });
    };
    scheduleUpdate();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(document.body);
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      resizeObserver.disconnect();
    };
  }, [subSections]);
  return currentIndex;
}

/** Scrolls to a sub-section of the current page, or to the top without a target. */
function scrollToSubSection(targetId) {
  if (!targetId) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  // The target may not exist yet while its data is still loading.
  document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function App() {
  const [activePageId, setActivePageId] = useState(getPageIdFromHash);
  const [selectedCommander, selectCommander] = useStoredState(COMMANDER_STORAGE_KEY, 'all');
  const commandersRequest = useApi('/api/commanders', {}, ['journals', 'stats']);
  const commanders = commandersRequest.data?.commanders ?? [];
  // The sidebar is a slide-in menu on narrow screens; this is whether it's open there.
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    // Each page opens at the top rather than at the previous page's scroll position.
    const handleHashChange = () => {
      setActivePageId(getPageIdFromHash());
      setIsMenuOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    if (!isMenuOpen) return undefined;
    const handleKeyDown = (keyEvent) => {
      if (keyEvent.key === 'Escape') setIsMenuOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMenuOpen]);

  // Fall back to "all" if the stored commander no longer exists.
  const isKnownCommander = selectedCommander === 'all' || commanders.some((commander) => String(commander.id) === selectedCommander);
  const commanderFilter = isKnownCommander || commanders.length === 0 ? selectedCommander : 'all';

  const activePage = PAGES.find((page) => page.id === activePageId);
  const ActivePage = activePage.component;
  const currentSubSectionIndex = useCurrentSubSectionIndex(activePage.subSections);
  const activeJournalCount = commandersRequest.data
    ? commanders.reduce((total, commander) => total + commander.active_journal_count, 0)
    : null;

  return (
    <div className="app">
      <MobileHeader isMenuOpen={isMenuOpen} onToggleMenu={() => setIsMenuOpen(!isMenuOpen)} activeJournalCount={activeJournalCount} />
      {isMenuOpen && <div className="sidebar-backdrop" onClick={() => setIsMenuOpen(false)} />}
      <aside id="sidebar" className={isMenuOpen ? 'sidebar sidebar-open' : 'sidebar'}>
        <div className="brand">
          <img className="brand-mark" src="/edjt-logo.svg" alt="" width="55" height="55" />
          <div>
            <div className="brand-title">ED Journal Tool</div>
            <div className="brand-version">v{__APP_VERSION__}</div>
          </div>
        </div>
        <nav className="nav">
          {PAGES.filter((page) => !page.isHiddenFromNav).map((page) => (
            <Fragment key={page.id}>
              <a href={`#/${page.id}`} className={page.id === activePageId ? 'nav-link nav-link-active' : 'nav-link'}>
                <NavIcon name={page.id} />
                {page.label}
              </a>
              {page.id === activePageId && page.subSections?.map((subSection, index) => (
                <button
                  key={subSection.label}
                  type="button"
                  className={index === currentSubSectionIndex ? 'nav-sublink nav-sublink-current' : 'nav-sublink'}
                  aria-current={index === currentSubSectionIndex ? 'location' : undefined}
                  onClick={() => {
                    setIsMenuOpen(false);
                    scrollToSubSection(subSection.targetId);
                  }}
                >
                  {subSection.label}
                </button>
              ))}
            </Fragment>
          ))}
        </nav>
        <LastTick />
        <ConnectionStatus isActive={activePageId === 'journals'} activeJournalCount={activeJournalCount} />
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{activePage.title ?? activePage.label}</h1>
          <label className="commander-select">
            <span>Commander</span>
            <select value={commanderFilter} onChange={(changeEvent) => selectCommander(changeEvent.target.value)}>
              <option value="all">All Commanders</option>
              {commanders.map((commander) => (
                <option key={commander.id} value={String(commander.id)}>CMDR {commander.name}</option>
              ))}
            </select>
          </label>
        </header>
        <JournalFolderBanner />
        <ScanBanner />
        <StatsBuildBanner />
        <CompressionBanner />
        <ClockBanner />
        <ActivePage commanderFilter={commanderFilter} commanders={commanders} />
      </main>
    </div>
  );
}

/** Status dot tone and text for the server connection and journal watch state. */
function useConnectionState(activeJournalCount) {
  const { isConnected } = useLiveUpdates();
  if (isConnected && activeJournalCount > 0) return { statusTone: 'live', statusText: `Active Journals: ${activeJournalCount}` };
  if (isConnected && activeJournalCount === 0) return { statusTone: 'warning', statusText: 'No Active Journals' };
  if (isConnected) return { statusTone: 'warning', statusText: 'Connecting…' };
  return { statusTone: 'danger', statusText: 'EDJT Not Running' };
}

const TICK_AGE_REFRESH_MS = 60 * 1000;

/**
 * The latest BGS tick the server has seen, and how long ago it was (re-rendered each minute so the
 * age stays current). tickTime is null until a tick has been seen.
 */
function useLastTick() {
  const ticksRequest = useApi('/api/stats/bgs/ticks', {}, ['ticks']);
  const [, setRefreshCount] = useState(0);
  useEffect(() => {
    const refreshTimer = setInterval(() => setRefreshCount((count) => count + 1), TICK_AGE_REFRESH_MS);
    return () => clearInterval(refreshTimer);
  }, []);
  const tickTime = ticksRequest.data?.ticks?.[0] ?? null;
  return {
    isLoaded: Boolean(ticksRequest.data),
    tickTime,
    age: tickTime ? formatRelativeTime(tickTime) : null,
    shortTime: tickTime ? formatShortTickTime(tickTime) : null,
  };
}

/** The tick's local time of day, or its date when it was more than a day ago. */
function formatShortTickTime(tickTime) {
  const tickDate = new Date(tickTime);
  return Date.now() - tickDate.getTime() < 24 * 60 * 60 * 1000
    ? tickDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : tickDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const COPIED_MESSAGE_MS = 1200;

/**
 * Copies the tick as a Discord timestamp ("<t:1795193566:t>", time only), which Discord shows in each reader's
 * own time zone. copyStatus is null, 'copied' or 'failed' for a moment after a click.
 */
function useTickCopy(tickTime) {
  const [copyStatus, setCopyStatus] = useState(null);
  useEffect(() => {
    if (!copyStatus) return undefined;
    const resetTimer = setTimeout(() => setCopyStatus(null), COPIED_MESSAGE_MS);
    return () => clearTimeout(resetTimer);
  }, [copyStatus]);
  const copyTick = async () => {
    const discordTimestamp = `<t:${Math.floor(Date.parse(tickTime) / 1000)}:t>`;
    setCopyStatus((await copyToClipboard(discordTimestamp)) ? 'copied' : 'failed');
  };
  return { copyStatus, copyTick };
}

function getTickTitle(tickTime) {
  return `Last BGS tick: ${formatDateTime(tickTime)}\nClick to copy as a Discord timestamp`;
}

/** Sidebar: the last BGS tick, above the connection status. Clicking copies a Discord timestamp. */
function LastTick() {
  const { isLoaded, tickTime, age, shortTime } = useLastTick();
  const { copyStatus, copyTick } = useTickCopy(tickTime);
  if (!isLoaded) return null;
  if (!tickTime) {
    return (
      <div className="last-tick" title="No BGS tick seen yet">
        <span className="last-tick-label">Last Tick</span>
        <span className="last-tick-value">Not seen yet</span>
      </div>
    );
  }
  return (
    <button type="button" className="last-tick" title={getTickTitle(tickTime)} onClick={copyTick}>
      <span className="last-tick-label">Last Tick</span>
      <span className="last-tick-value">
        {copyStatus
          ? <span className={`copy-status-text copy-status-text-${copyStatus}`}>{copyStatus === 'copied' ? 'Copied' : 'Copy failed'}</span>
          : <>{shortTime} <span className="muted">({age.replace(/ ago$/, '')})</span></>}
      </span>
    </button>
  );
}

/** Mobile header: a compact tick age beside the status dot. Tapping copies a Discord timestamp. */
function MobileLastTick() {
  const { tickTime, age } = useLastTick();
  const { copyStatus, copyTick } = useTickCopy(tickTime);
  if (!tickTime) return null;
  return (
    <button type="button" className="mobile-header-tick" title={getTickTitle(tickTime)} onClick={copyTick}>
      {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed' : `Last Tick ${age}`}
    </button>
  );
}

/** On narrow screens: the bar with the menu button that replaces the always-visible sidebar. */
function MobileHeader({ isMenuOpen, onToggleMenu, activeJournalCount }) {
  const { statusTone, statusText } = useConnectionState(activeJournalCount);
  return (
    <header className="mobile-header">
      <button
        type="button"
        className="menu-button"
        aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={isMenuOpen}
        aria-controls="sidebar"
        onClick={onToggleMenu}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {isMenuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      <img className="mobile-header-logo" src="/edjt-logo.svg" alt="" width="32" height="32" />
      <span className="brand-title">ED Journal Tool</span>
      <MobileLastTick />
      <a href="#/journals" className="mobile-header-status" title={statusText} aria-label={statusText}>
        <span className={`status-dot status-dot-${statusTone}`} />
      </a>
    </header>
  );
}

/**
 * Server connection and journal watch state; clicking it opens the Journals page. The count is null
 * until the commander list has loaded.
 */
function ConnectionStatus({ activeJournalCount, isActive }) {
  const { lastUpdate } = useLiveUpdates();
  const { statusTone, statusText } = useConnectionState(activeJournalCount);

  return (
    <a href="#/journals" className={isActive ? 'connection-status connection-status-active' : 'connection-status'} title="Show journals">
      <span className={`status-dot status-dot-${statusTone}`} />
      <div>
        <div>{statusText}</div>
        {lastUpdate && <div className="muted small">Last update {new Date(lastUpdate.timestamp).toLocaleTimeString()}</div>}
      </div>
    </a>
  );
}

/**
 * Warns when the server's clock is off from the game server's, since carrier timers depend on it.
 * On the Windows computer itself, it links to Windows' Date & Time settings, whose "Sync now"
 * needs no administrator rights (EDJT can't sync the clock itself without them). The browser asks
 * before opening it.
 */
function ClockBanner() {
  const statusRequest = useApi('/api/status', {}, ['clock']);
  const clockStatus = statusRequest.data?.clock;
  if (!clockStatus?.isOff) return null;
  const direction = clockStatus.offsetSeconds > 0 ? 'ahead of' : 'behind';
  return (
    <div className="notice notice-warning">
      {statusRequest.data.isLocal ? 'This computer' : 'The EDJT computer'}'s clock is about {Math.abs(clockStatus.offsetSeconds).toFixed(1)}s {direction} the game server, so carrier
      jump and cooldown timers will be off by that much.{' '}
      {statusRequest.data.canOpenTimeSettings
        ? <>Synchronize the clock to fix it: <a href="ms-settings:dateandtime">open Date &amp; Time settings</a> and click <b>Sync now</b>.</>
        : 'Synchronize the system clock to fix it.'}
    </div>
  );
}

/** Says when no journal folder has been found (the game not installed or run yet, or somewhere unusual). */
function JournalFolderBanner() {
  const statusRequest = useApi('/api/status', {}, ['scan', 'journals']);
  const search = statusRequest.data?.journalSearch;
  if (!search?.isWaiting) return null;
  return (
    <div className="notice notice-warning">
      {search.isAutomatic
        ? <>No Elite Dangerous journal folder found yet (looked in {search.lookedIn}). </>
        : <>The journal folder isn't there: {search.lookedIn}. </>}
      It's checked again every minute and read as soon as it's there. If the game keeps its journals
      somewhere else, restart ED Journal Tool with <code>--journaldir</code> and that folder.
    </div>
  );
}

function ScanBanner() {
  const { scanProgress } = useLiveUpdates();
  const statusRequest = useApi('/api/status', {}, ['scan']);
  const currentScan = scanProgress ?? statusRequest.data?.scan;
  if (!currentScan?.isScanning) return null;
  return (
    <div className="notice notice-info">
      Scanning journals: {currentScan.processedFiles.toLocaleString()} / {currentScan.totalFiles.toLocaleString()} files
      ({currentScan.newEntries.toLocaleString()} new entries). Stats will update when the scan completes.
    </div>
  );
}

/**
 * While stats are built from many entries (after the startup scan, a new or changed stat, or a
 * rebuild): which one, and how far along. Hidden during the scan, which has its own banner.
 */
function StatsBuildBanner() {
  const { scanProgress, statsBuildProgress } = useLiveUpdates();
  const statusRequest = useApi('/api/status', {}, ['scan']);
  const build = statsBuildProgress ?? statusRequest.data?.statsBuild;
  const isScanning = (scanProgress ?? statusRequest.data?.scan)?.isScanning;
  if (!build?.isBuilding || isScanning) return null;
  return (
    <div className="notice notice-info">
      Building stats{build.currentModule ? `: ${build.currentModule.title}` : ''} ({build.completedModules.toLocaleString()} of{' '}
      {build.totalModules.toLocaleString()} done, {build.percent}%). The dashboard updates when it's finished.
    </div>
  );
}

/** While stored journal entries are compressed (once, after the first scan on a new system). */
function CompressionBanner() {
  const { compressionProgress } = useLiveUpdates();
  const statusRequest = useApi('/api/status', {}, ['scan']);
  const compression = compressionProgress ?? statusRequest.data?.compression;
  if (!compression?.isCompressing) return null;
  return (
    <div className="notice notice-info">
      Compressing stored journal entries to save space (only done once): {compression.checkedCount.toLocaleString()} /{' '}
      {compression.totalCount.toLocaleString()} ({compression.percent}%). The dashboard works meanwhile, if a little slower.
    </div>
  );
}
