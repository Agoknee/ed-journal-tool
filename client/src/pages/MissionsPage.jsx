import { useNow } from '../hooks/use-now.js';
import { CargoSection } from './missions/CargoSection.jsx';
import { HistorySection } from './missions/HistorySection.jsx';
import { MassacreSection } from './missions/MassacreSection.jsx';
import { MINUTE_MS } from './missions/mission-display.jsx';
import { OverviewSection } from './missions/OverviewSection.jsx';
import './missions/missions.css';

export default function MissionsPage({ commanderFilter }) {
  // Re-rendered every minute so expiry countdowns stay current.
  useNow(MINUTE_MS);
  return (
    <>
      <OverviewSection commanderFilter={commanderFilter} />
      <MassacreSection commanderFilter={commanderFilter} />
      <CargoSection commanderFilter={commanderFilter} />
      <HistorySection commanderFilter={commanderFilter} />
    </>
  );
}
