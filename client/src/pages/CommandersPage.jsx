import { useState } from 'react';
import CopyableText from '../components/CopyableText.jsx';
import DataTable from '../components/DataTable.jsx';
import { Badge, KeyValueList, LoadingState, Section, StatCard, StatGrid, Tabs } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import {
  formatCredits, formatDateTime, formatDuration, formatNumber, formatRelativeTime, formatShipName,
  formatSystemName,
} from '../format.js';

export default function CommandersPage({ commanderFilter }) {
  const commanderParams = { commander: commanderFilter };
  const profilesRequest = useApi('/api/stats/commanders', commanderParams);
  const locationsRequest = useApi('/api/stats/travel/locations', commanderParams);
  const assetsRequest = useApi('/api/stats/assets', commanderParams);
  const carriersRequest = useApi('/api/stats/carriers', commanderParams);

  const locationsByCommander = indexBy(locationsRequest.data?.locations, 'commander_id');
  const assetsByCommander = indexBy(assetsRequest.data?.perCommander, 'commanderId');
  const carrierStatusByCommander = indexBy(carriersRequest.data?.commanderStatuses, 'commanderId');

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

      <Section title="Commander Details" description="Click a value to copy it to the clipboard.">
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
                />
              ))}
            </div>
          )}
        </LoadingState>
      </Section>

      {commanderFilter !== 'all' && <AssetDetailsSection commanderId={commanderFilter} />}
    </>
  );
}

function CommanderCard({ profile, location, assets, carrierStatus }) {
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
          value: formatShipName(profile.ship_type_name ?? profile.ship_type, profile.ship_name),
          copyText: profile.ship_name ?? profile.ship_type_name ?? profile.ship_type,
        },
        { label: 'Credits', value: formatCredits(assets?.credits), copyText: assets?.credits },
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

const ASSET_TABS = [
  { id: 'fleet', label: 'Fleet' },
  { id: 'modules', label: 'Stored modules' },
  { id: 'materials', label: 'Materials' },
  { id: 'locker', label: 'Ship locker' },
  { id: 'cargo', label: 'Cargo' },
];

function AssetDetailsSection({ commanderId }) {
  const [activeTab, setActiveTab] = useState('fleet');
  const assetsRequest = useApi(`/api/stats/assets/${commanderId}`);

  return (
    <Section title="Assets" actions={<Tabs tabs={ASSET_TABS} activeTab={activeTab} onChange={setActiveTab} />}>
      <LoadingState requestState={assetsRequest}>
        {(assets) => {
          switch (activeTab) {
            case 'fleet':
              return (
                <DataTable
                  tableId="commanders.fleet"
                  rowKey="shipId"
                  rows={assets.fleet}
                  emptyMessage="No ships recorded yet (visit a shipyard to record stored ships)."
                  columns={[
                    { key: 'shipType', label: 'Ship', render: (ship) => <>{ship.shipType} {ship.isCurrent && <Badge tone="live">Current</Badge>}</> },
                    { key: 'shipName', label: 'Name' },
                    { key: 'starSystem', label: 'Location', render: (ship) => (ship.isCurrent ? 'With commander' : formatSystemName(ship.starSystem) ?? '—') },
                    { key: 'value', label: 'Value', align: 'right', render: (ship) => formatCredits(ship.value) },
                  ]}
                />
              );
            case 'modules':
              return (
                <AssetTable
                  tableId="commanders.storedModules"
                  rows={assets.storedModules?.items}
                  updatedAt={assets.updatedAt.storedModules}
                  columns={[
                    { key: 'name', label: 'Module' },
                    { key: 'engineering', label: 'Engineering', render: (storedModule) => (storedModule.engineering ? `${storedModule.engineering} G${storedModule.engineeringLevel}` : '—') },
                    { key: 'starSystem', label: 'Location', render: (storedModule) => formatSystemName(storedModule.starSystem) ?? '—' },
                    { key: 'value', label: 'Value', align: 'right', render: (storedModule) => formatCredits(storedModule.value) },
                  ]}
                />
              );
            case 'materials':
              return (
                <AssetTable
                  tableId="commanders.materials"
                  rows={[
                    ...(assets.materials?.raw ?? []).map((material) => ({ ...material, category: 'Raw' })),
                    ...(assets.materials?.manufactured ?? []).map((material) => ({ ...material, category: 'Manufactured' })),
                    ...(assets.materials?.encoded ?? []).map((material) => ({ ...material, category: 'Encoded' })),
                  ]}
                  updatedAt={assets.updatedAt.materials}
                  columns={[{ key: 'category', label: 'Category' }, { key: 'name', label: 'Material' }, { key: 'count', label: 'Count', align: 'right' }]}
                />
              );
            case 'locker':
              return (
                <AssetTable
                  tableId="commanders.shipLocker"
                  rows={['items', 'components', 'consumables', 'data'].flatMap((category) => (assets.shipLocker?.[category] ?? [])
                    .map((lockerItem) => ({ ...lockerItem, category: category.charAt(0).toUpperCase() + category.slice(1) })))}
                  updatedAt={assets.updatedAt.shipLocker}
                  columns={[{ key: 'category', label: 'Category' }, { key: 'name', label: 'Item' }, { key: 'count', label: 'Count', align: 'right' }]}
                />
              );
            case 'cargo':
              return (
                <AssetTable
                  tableId="commanders.cargo"
                  rows={assets.cargo?.inventory}
                  updatedAt={assets.updatedAt.cargo}
                  columns={[
                    { key: 'name', label: 'Commodity' },
                    { key: 'count', label: 'Tonnes', align: 'right' },
                    { key: 'stolen', label: 'Stolen', align: 'right' },
                  ]}
                />
              );
            default:
              return null;
          }
        }}
      </LoadingState>
    </Section>
  );
}

function AssetTable({ tableId, rows, columns, updatedAt }) {
  return (
    <>
      {updatedAt && <p className="muted small">Snapshot from {formatDateTime(updatedAt)}</p>}
      <DataTable tableId={tableId} rowKey="rowId" rows={(rows ?? []).map((row, index) => ({ ...row, rowId: index }))} columns={columns} emptyMessage="Nothing recorded." />
    </>
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
