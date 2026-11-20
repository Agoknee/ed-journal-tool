import { useEffect, useState } from 'react';
import { useLiveUpdates } from './hooks/live-updates-context.js';
import { useApi } from './hooks/use-api.js';
import CarriersPage from './pages/CarriersPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import CommandersPage from './pages/CommandersPage.jsx';
import CommoditiesPage from './pages/CommoditiesPage.jsx';
import TravelPage from './pages/TravelPage.jsx';
import DepotsPage from './pages/DepotsPage.jsx';
import JournalsPage from './pages/JournalsPage.jsx';

const PAGES = [
  { id: 'commanders', label: 'Commanders', component: CommandersPage },
  { id: 'travel', label: 'Travel', component: TravelPage },
  { id: 'carriers', label: 'Carriers', component: CarriersPage },
  { id: 'commodities', label: 'Commodities', component: CommoditiesPage },
  { id: 'depots', label: 'Depots', component: DepotsPage },
  { id: 'chat', label: 'Chat', component: ChatPage },
  { id: 'journals', label: 'Journals', component: JournalsPage },
];

const COMMANDER_STORAGE_KEY = 'selectedCommander';

function getPageIdFromHash() {
  const hashPageId = window.location.hash.replace('#/', '').replace('#', '');
  return PAGES.some((page) => page.id === hashPageId) ? hashPageId : PAGES[0].id;
}

function readStoredCommander() {
  try {
    return localStorage.getItem(COMMANDER_STORAGE_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

export default function App() {
  const [activePageId, setActivePageId] = useState(getPageIdFromHash);
  const [selectedCommander, setSelectedCommander] = useState(readStoredCommander);
  const commandersRequest = useApi('/api/commanders', {}, ['journals', 'stats']);
  const commanders = commandersRequest.data?.commanders ?? [];

  useEffect(() => {
    const handleHashChange = () => setActivePageId(getPageIdFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const selectCommander = (commanderValue) => {
    setSelectedCommander(commanderValue);
    try {
      localStorage.setItem(COMMANDER_STORAGE_KEY, commanderValue);
    } catch {
      // Storage may be unavailable (private mode); the selection still works for this session.
    }
  };

  // Fall back to "all" if the stored commander no longer exists.
  const isKnownCommander = selectedCommander === 'all' || commanders.some((commander) => String(commander.id) === selectedCommander);
  const commanderFilter = isKnownCommander || commanders.length === 0 ? selectedCommander : 'all';

  const ActivePage = PAGES.find((page) => page.id === activePageId).component;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <div>
            <div className="brand-title">Journal Tool <span className="brand-version">v{__APP_VERSION__}</span></div>
            <div className="brand-subtitle">Elite Dangerous</div>
          </div>
        </div>
        <nav className="nav">
          {PAGES.map((page) => (
            <a key={page.id} href={`#/${page.id}`} className={page.id === activePageId ? 'nav-link nav-link-active' : 'nav-link'}>
              {page.label}
            </a>
          ))}
        </nav>
        <ConnectionStatus />
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{PAGES.find((page) => page.id === activePageId).label}</h1>
          <label className="commander-select">
            <span>Commander</span>
            <select value={commanderFilter} onChange={(changeEvent) => selectCommander(changeEvent.target.value)}>
              <option value="all">All commanders</option>
              {commanders.map((commander) => (
                <option key={commander.id} value={String(commander.id)}>CMDR {commander.name}</option>
              ))}
            </select>
          </label>
        </header>
        <ScanBanner />
        <ActivePage commanderFilter={commanderFilter} commanders={commanders} />
      </main>
    </div>
  );
}

function ConnectionStatus() {
  const { isConnected, lastUpdate } = useLiveUpdates();
  return (
    <div className="connection-status">
      <span className={isConnected ? 'status-dot status-dot-live' : 'status-dot'} />
      <div>
        <div>{isConnected ? 'Live updates on' : 'Reconnecting…'}</div>
        {lastUpdate && <div className="muted small">Last update {new Date(lastUpdate.timestamp).toLocaleTimeString()}</div>}
      </div>
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
