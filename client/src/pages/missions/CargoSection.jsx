import { useState } from 'react';
import DataTable from '../../components/DataTable.jsx';
import { Badge, LoadingState, ProgressBar, Section } from '../../components/ui.jsx';
import { formatCredits, formatFullCredits, formatNumber } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';
import { getCategoryLabel, getDestinationText, renderExpiry, renderMissionFaction, renderPlace, renderStatus } from './mission-display.jsx';

export function CargoSection({ commanderFilter }) {
  const [showAllTypes, setShowAllTypes] = useState(false);
  const cargoRequest = useApi('/api/stats/missions/cargo', { commander: commanderFilter });
  const showCommander = commanderFilter === 'all';

  return (
    <Section
      id="missions-cargo"
      title="Mining & Cargo"
      description="Open missions that need a commodity, with what’s been delivered and what’s already in the hold (from the latest cargo update)."
      actions={(
        <label className="checkbox">
          <input type="checkbox" checked={showAllTypes} onChange={(changeEvent) => setShowAllTypes(changeEvent.target.checked)} />
          Include Delivery and Source Missions
        </label>
      )}
    >
      <LoadingState requestState={cargoRequest}>
        {({ missions: allMissions }) => {
          const missions = showAllTypes ? allMissions : allMissions.filter((mission) => mission.category === 'mining');
          if (missions.length === 0) {
            return <div className="notice">{showAllTypes ? 'No open cargo missions.' : 'No open mining missions.'}</div>;
          }
          const commodities = summarizeCommodities(missions, cargoRequest.data.commodities);
          return (
            <>
              <DataTable
                tableId="missions.cargoCommodities"
                rowKey="key"
                rows={commodities}
                columns={[
                  { key: 'commodityName', label: 'Commodity' },
                  ...(showCommander ? [{ key: 'commanderName', label: 'Commander', render: (row) => `CMDR ${row.commanderName}` }] : []),
                  { key: 'missionCount', label: 'Missions', align: 'right' },
                  {
                    key: 'progress',
                    label: 'Delivered',
                    sortValue: (row) => row.delivered / (row.required || 1),
                    render: (row) => (
                      <span className="mission-progress-cell">
                        <ProgressBar value={row.delivered} max={row.required} />
                        <span>{formatNumber(row.delivered)} / {formatNumber(row.required)} t</span>
                      </span>
                    ),
                  },
                  { key: 'remaining', label: 'Remaining', align: 'right', render: (row) => `${formatNumber(row.remaining)} t` },
                  { key: 'inCargo', label: 'In Hold', align: 'right', render: (row) => (row.inCargo ? `${formatNumber(row.inCargo)} t` : <span className="muted">—</span>) },
                  {
                    key: 'stillToFind',
                    label: 'Still Needed',
                    align: 'right',
                    render: (row) => (row.stillToFind ? <strong>{formatNumber(row.stillToFind)} t</strong> : <Badge tone="live">Have enough</Badge>),
                  },
                  { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
                ]}
              />
              <h3 className="subheading">Missions</h3>
              <DataTable
                tableId="missions.cargoMissions"
                rows={missions}
                columns={[
                  { key: 'category', label: 'Type', render: (row) => getCategoryLabel(row.category) },
                  ...(showCommander ? [{ key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` }] : []),
                  { key: 'commodity_name', label: 'Commodity' },
                  {
                    key: 'progress',
                    label: 'Delivered',
                    sortValue: (row) => row.delivered / (row.commodity_count || 1),
                    render: (row) => (
                      <span className="mission-progress-cell">
                        <ProgressBar value={row.delivered} max={row.commodity_count} />
                        <span>{formatNumber(row.delivered)} / {formatNumber(row.commodity_count)} t</span>
                      </span>
                    ),
                  },
                  { key: 'faction', label: 'Faction', wrap: true, render: renderMissionFaction },
                  {
                    key: 'destination',
                    label: 'Deliver To',
                    sortValue: getDestinationText,
                    render: (row) => renderPlace(row.destination_system, row.destination_station),
                  },
                  { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
                  { key: 'status', label: 'Status', render: renderStatus },
                  { key: 'expiry', label: 'Expires', render: renderExpiry },
                ]}
              />
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}

/** The server's commodity totals, limited to the commodities of the missions shown. */
function summarizeCommodities(missions, allCommodities) {
  const totalsByKey = new Map();
  for (const mission of missions) {
    const key = `${mission.commander_id}|${mission.commodity}`;
    const totals = totalsByKey.get(key) ?? { missionCount: 0, required: 0, delivered: 0, remaining: 0, reward: 0 };
    totals.missionCount += 1;
    totals.required += mission.commodity_count;
    totals.delivered += mission.delivered;
    totals.remaining += mission.remaining;
    totals.reward += mission.reward ?? 0;
    totalsByKey.set(key, totals);
  }
  return allCommodities
    .filter((commodity) => totalsByKey.has(commodity.key))
    .map((commodity) => {
      const totals = totalsByKey.get(commodity.key);
      return { ...commodity, ...totals, stillToFind: Math.max(0, totals.remaining - commodity.inCargo) };
    });
}
