import { useState } from 'react';
import CopyableText from '../components/CopyableText.jsx';
import { Badge, KeyValueList, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import {
  formatCredits, formatDuration, formatNumber, formatRelativeTime, formatShipName,
  formatSystemName,
} from '../format.js';
import CreditsSection from './commanders/CreditsSection.jsx';
import EngineersSection from './commanders/EngineersSection.jsx';
import FleetSection from './commanders/FleetSection.jsx';
import InventorySection from './commanders/InventorySection.jsx';
import RanksSection from './commanders/RanksSection.jsx';

const DETAIL_COMMANDER_STORAGE_KEY = 'commanders.detailCommander';

export default function CommandersPage({ commanderFilter }) {
  const commanderParams = { commander: commanderFilter };
  const profilesRequest = useApi('/api/stats/commanders', commanderParams);
  const locationsRequest = useApi('/api/stats/travel/locations', commanderParams);
  const assetsRequest = useApi('/api/stats/assets', commanderParams);
  const carriersRequest = useApi('/api/stats/carriers', commanderParams);

  const locationsByCommander = indexBy(locationsRequest.data?.locations, 'commander_id');
  const assetsByCommander = indexBy(assetsRequest.data?.perCommander, 'commanderId');
  const carrierStatusByCommander = indexBy(carriersRequest.data?.commanderStatuses, 'commanderId');

  // The detail sections show one commander: the one chosen at the top of the app, or with all
  // commanders shown, the one picked here (remembered in the browser).
  const [pickedCommanderId, setPickedCommanderId] = useState(readStoredCommanderId);
  const profiles = sortCommandersForDisplay(profilesRequest.data?.commanders ?? []);
  const detailCommanderId = commanderFilter !== 'all'
    ? Number(commanderFilter)
    : profiles.some((profile) => profile.id === pickedCommanderId) ? pickedCommanderId : profiles[0]?.id ?? null;
  const pickCommander = (commanderId) => {
    setPickedCommanderId(commanderId);
    try {
      localStorage.setItem(DETAIL_COMMANDER_STORAGE_KEY, String(commanderId));
    } catch {
      // Storage may be unavailable; the choice still applies for this visit.
    }
  };
  // Clicking a commander card's ship or credits shows that commander's details and scrolls to them
  // once they've loaded (the sections act on the request; the nonce makes each click count).
  const [focusRequest, setFocusRequest] = useState(null);
  const showDetails = (commanderId, target) => {
    if (commanderFilter === 'all' && commanderId !== detailCommanderId) pickCommander(commanderId);
    setFocusRequest((previous) => ({ target, commanderId, nonce: (previous?.nonce ?? 0) + 1 }));
  };
  const picker = commanderFilter === 'all' && profiles.length > 1 ? (
    <select className="commander-picker" aria-label="Commander" value={detailCommanderId ?? ''} onChange={(changeEvent) => pickCommander(Number(changeEvent.target.value))}>
      {profiles.map((profile) => <option key={profile.id} value={profile.id}>CMDR {profile.name}</option>)}
    </select>
  ) : null;

  return (
    <>
      <Section title="Overview">
        <LoadingState requestState={assetsRequest}>
          {({ combined, perCommander }) => (
            <StatGrid>
              <StatCard label="Commanders" value={perCommander.length} />
              <StatCard label="Credits" value={formatCredits(combined.credits)} detail="Last known balance" />
              <StatCard label="Ships" value={formatNumber(combined.shipCount)} detail={`Fleet value ${formatCredits(combined.fleetValue)}`} />
              <StatCard label="Stored modules" value={formatNumber(combined.storedModuleCount)} />
              <StatCard label="Materials" value={formatNumber(combined.materialCount)} />
              <StatCard label="Cargo" value={`${formatNumber(combined.cargoCount)} t`} />
            </StatGrid>
          )}
        </LoadingState>
      </Section>

      <Section title="Commander Details" description="Click a value to copy it to the clipboard, or the ship or credits to see their details below.">
        <LoadingState requestState={profilesRequest} emptyMessage="No commanders found yet.">
          {({ commanders }) => commanders.length > 0 && (
            <div className="card-grid">
              {sortCommandersForDisplay(commanders).map((profile) => (
                <CommanderCard
                  key={profile.id}
                  profile={profile}
                  location={locationsByCommander[profile.id]}
                  assets={assetsByCommander[profile.id]}
                  carrierStatus={carrierStatusByCommander[profile.id]?.carrierStatus}
                  onShowShip={() => showDetails(profile.id, 'loadout')}
                  onShowCredits={() => showDetails(profile.id, 'credits')}
                />
              ))}
            </div>
          )}
        </LoadingState>
      </Section>

      <FleetSection commanderId={detailCommanderId} picker={picker} focusRequest={focusRequest} />
      <InventorySection commanderId={detailCommanderId} picker={picker} />
      <RanksSection commanderId={detailCommanderId} picker={picker} />
      <CreditsSection commanderId={detailCommanderId} picker={picker} focusRequest={focusRequest} />
      <EngineersSection commanderId={detailCommanderId} picker={picker} />
    </>
  );
}

function CommanderCard({ profile, location, assets, carrierStatus, onShowShip, onShowCredits }) {
  const ranks = profile.rank_names ?? {};
  const isOnline = profile.active_journal_count > 0;
  return (
    <article className="card">
      <header className="card-header">
        <div>
          <h3><CopyableText copyText={profile.name}>CMDR {profile.name}</CopyableText></h3>
          <div className="muted small">
            {profile.fid ? <CopyableText copyText={profile.fid}>{profile.fid}</CopyableText> : '—'} · last seen {formatRelativeTime(profile.last_seen)}
          </div>
        </div>
        <div className="badge-row">
          {isOnline && <Badge tone="live">Online</Badge>}
        </div>
      </header>
      <KeyValueList items={[
        { label: 'Location', value: formatSystemName(location?.star_system), copyText: location?.star_system },
        location?.is_docked
          ? {
            label: 'Docked at',
            value: `${location.station_name ?? '—'}${location.station_type ? ` (${location.station_type})` : ''}`,
            copyText: location.station_name,
          }
          : location?.body && { label: 'Near', value: location.body, copyText: location.body },
        {
          label: 'Ship',
          value: (
            <button type="button" className="link-button link-button-plain" onClick={onShowShip} title="Show this ship’s loadout">
              {formatShipName(profile.ship_type_name ?? profile.ship_type, profile.ship_name)}
            </button>
          ),
        },
        {
          label: 'Credits',
          value: (
            <button type="button" className="link-button link-button-plain" onClick={onShowCredits} title="Show this commander’s credits">
              {formatCredits(assets?.credits)}
            </button>
          ),
        },
        { label: 'Fleet', value: assets ? `${assets.shipCount} ships · ${formatCredits(assets.fleetValue)}` : null },
        { label: 'Carrier', value: carrierStatus ?? 'None' },
        isOnline && { label: 'Game mode', value: profile.game_mode ? `${profile.game_mode}${profile.game_group ? ` (${profile.game_group})` : ''}` : null },
        profile.squadron_name && {
          label: 'Squadron',
          value: `${profile.squadron_name}${profile.squadron_rank ? ` · ${profile.squadron_rank}` : ''}`,
          copyText: profile.squadron_name,
        },
        { label: 'Time played', value: formatDuration(profile.time_played_s) },
        { label: 'Journals', value: formatNumber(profile.journal_file_count) },
      ]} />
      {Object.keys(ranks).length > 0 && (
        <div className="rank-list">
          {['Combat', 'Trade', 'Explore', 'Exobiologist', 'Soldier', 'Federation', 'Empire'].filter((rankType) => ranks[rankType]).map((rankType) => (
            <span key={rankType} className="rank-chip"><span className="muted">{rankType}</span> {ranks[rankType]}</span>
          ))}
        </div>
      )}
    </article>
  );
}

/** Active (online) commanders first, then everyone else; alphabetical within each group so cards don't move around. */
function sortCommandersForDisplay(commanders) {
  return [...commanders].sort((first, second) => {
    const activeDifference = Number(second.active_journal_count > 0) - Number(first.active_journal_count > 0);
    return activeDifference || first.name.localeCompare(second.name, undefined, { sensitivity: 'base' });
  });
}

function indexBy(rows, keyName) {
  return Object.fromEntries((rows ?? []).map((row) => [row[keyName], row]));
}

function readStoredCommanderId() {
  try {
    const storedValue = Number(localStorage.getItem(DETAIL_COMMANDER_STORAGE_KEY));
    return Number.isInteger(storedValue) && storedValue > 0 ? storedValue : null;
  } catch {
    return null;
  }
}
