import { useState } from 'react';
import CopyableText from '../components/CopyableText.jsx';
import { Badge, KeyValueList, LoadingState, Section, StatGrid, StatGroupCard } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { STORED_ID, useStoredState } from '../hooks/use-stored-state.js';
import {
  formatCredits, formatDuration, formatNumber, formatRelativeTime, formatShipName,
  formatSystemName,
} from '../format.js';
import CreditsSection from './commanders/CreditsSection.jsx';
import EngineersSection from './commanders/EngineersSection.jsx';
import FleetSection from './commanders/FleetSection.jsx';
import InventorySection from './commanders/InventorySection.jsx';
import RanksSection from './commanders/RanksSection.jsx';
import ShipRouteButtons from './commanders/ShipRouteButtons.jsx';
import './commanders/commanders.css';

const DETAIL_COMMANDER_STORAGE_KEY = 'commanders.detailCommander';

export default function CommandersPage({ commanderFilter }) {
  const commanderParams = { commander: commanderFilter };
  const profilesRequest = useApi('/api/stats/commanders', commanderParams);
  const locationsRequest = useApi('/api/stats/travel/locations', commanderParams);

  const locationsByCommander = indexBy(locationsRequest.data?.locations, 'commander_id');

  // The detail sections show one commander: the one chosen at the top of the app, or with all
  // commanders shown, the one picked here (remembered in the browser).
  const [pickedCommanderId, pickCommander] = useStoredState(DETAIL_COMMANDER_STORAGE_KEY, null, STORED_ID);
  const profiles = sortCommandersForDisplay(profilesRequest.data?.commanders ?? []);
  const detailCommanderId = commanderFilter !== 'all'
    ? Number(commanderFilter)
    : profiles.some((profile) => profile.id === pickedCommanderId) ? pickedCommanderId : profiles[0]?.id ?? null;
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
        <LoadingState requestState={profilesRequest}>
          {({ combined, commanders }) => <OverviewCards combined={combined} commanders={commanders} />}
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

/**
 * The overview: four grouped cards (commanders, credits, fleet, inventory), each a headline figure
 * with a couple of related ones under it, across all the commanders shown.
 */
function OverviewCards({ combined, commanders }) {
  const onlineCount = commanders.filter((profile) => profile.active_journal_count > 0).length;
  // Time played is the game's own figure for each commander, added up.
  const played = commanders.filter((profile) => profile.time_played_s > 0);
  const playedSeconds = played.reduce((total, profile) => total + profile.time_played_s, 0);
  const mostPlayed = played.reduce((most, profile) => (!most || profile.time_played_s > most.time_played_s ? profile : most), null);
  return (
    <StatGrid className="stat-grid-groups">
      <StatGroupCard
        label="Commanders"
        value={formatNumber(commanders.length)}
        rows={[
          { label: 'Online', value: formatNumber(onlineCount) },
          {
            label: 'Time played',
            value: playedSeconds > 0 ? formatDuration(playedSeconds) : null,
            title: mostPlayed && played.length > 1 ? `Most played: CMDR ${mostPlayed.name} (${formatDuration(mostPlayed.time_played_s)})` : undefined,
          },
        ]}
      />
      <StatGroupCard
        label="Credits"
        value={formatCredits(combined.credits)}
        title="Each commander’s last known balance, added up"
        rows={[
          { label: 'Total wealth', value: combined.currentWealth ? formatCredits(combined.currentWealth) : null, title: 'Credits and assets, per the game’s own statistics' },
        ]}
      />
      <StatGroupCard
        label="Fleet"
        value={formatNumber(combined.shipCount)}
        unit={combined.shipCount === 1 ? 'ship' : 'ships'}
        rows={[
          { label: 'Fleet value', value: formatCredits(combined.fleetValue) },
          { label: 'Stored modules', value: formatNumber(combined.storedModuleCount) },
        ]}
      />
      <StatGroupCard
        label="Inventory"
        value={formatNumber(combined.materialCount)}
        unit="materials"
        rows={[
          { label: 'Cargo', value: `${formatNumber(combined.cargoCount)} t` },
          { label: 'Ship locker', value: `${formatNumber(combined.shipLockerCount)} items`, title: 'On-foot items: goods, assets and data' },
        ]}
      />
    </StatGrid>
  );
}

function CommanderCard({ profile, location, onShowShip, onShowCredits }) {
  const { summary } = profile;
  const currentShip = summary.currentShip;
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
        <div className="badge-row commander-card-badges">
          {isOnline && <Badge tone="live">Online</Badge>}
          {currentShip && (
            <ShipRouteButtons
              commanderId={profile.id}
              ship={currentShip}
              source={location?.star_system ? { name: location.star_system, id64: location.system_address ?? undefined } : null}
            />
          )}
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
              {formatShipName(currentShip?.shipTypeName, currentShip?.name)}
            </button>
          ),
        },
        {
          label: 'Credits',
          value: (
            <button type="button" className="link-button link-button-plain" onClick={onShowCredits} title="Show this commander’s credits">
              {formatCredits(summary.credits)}
            </button>
          ),
        },
        { label: 'Fleet', value: `${formatNumber(summary.shipCount)} ships · ${formatCredits(summary.fleetValue)}` },
        isOnline && { label: 'Game mode', value: profile.game_mode ? `${profile.game_mode}${profile.game_group ? ` (${profile.game_group})` : ''}` : null },
        profile.squadron_name && {
          label: 'Squadron',
          value: `${profile.squadron_name}${profile.squadron_rank ? ` · ${profile.squadron_rank}` : ''}`,
          copyText: profile.squadron_name,
        },
        { label: 'Time played', value: formatDuration(profile.time_played_s) },
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
