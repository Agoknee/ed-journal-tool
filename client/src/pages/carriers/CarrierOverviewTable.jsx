import CopyableText from '../../components/CopyableText.jsx';
import DataTable from '../../components/DataTable.jsx';
import { formatNumber } from '../../format.js';
import { useNow } from '../../hooks/use-now.js';
import { buildOverviewRows, formatCountdown, getJumpLockLabel, getJumpState, renderSquadronId, renderSystemAndBody } from './carrier-display.jsx';
import { NoteCell } from './NoteCell.jsx';

const COUNTDOWN_UPDATE_INTERVAL_MS = 200;

export function CarrierOverviewTable({ commanderStatuses, carriers, includeCommandersWithoutCarrier }) {
  const allRows = buildOverviewRows(commanderStatuses, carriers);
  // Hidden commanders stay in the table, collapsed, so column widths don't change when they're shown.
  const hasVisibleRows = allRows.some((row) => row.carrier || includeCommandersWithoutCarrier);
  const overviewRows = hasVisibleRows ? allRows : [];
  // Countdowns tick every 200ms while any carrier has a jump under way.
  const now = useNow(COUNTDOWN_UPDATE_INTERVAL_MS, (currentTime) => overviewRows.some((row) => getJumpState(row.carrier, currentTime)));

  return (
    <DataTable
      tableId="carriers.overview"
      rowKey="rowKey"
      rows={overviewRows}
      rowClassName={(row) => (!row.carrier && !includeCommandersWithoutCarrier ? 'collapsed-row' : undefined)}
      emptyMessage={includeCommandersWithoutCarrier ? 'No commanders.' : 'No commander owns a carrier.'}
      columns={[
        { key: 'commander', label: 'Commander', sortValue: ({ status }) => status.commanderName, shrink: true, className: 'overview-name-cell', render: ({ status }) => <CopyableText copyText={status.commanderName}>CMDR {status.commanderName}</CopyableText> },
        { key: 'squadron', label: 'Squadron', sortValue: ({ status }) => status.squadronId, shrink: true, render: ({ status }) => renderSquadronId(status.squadronId, status.squadronName) },
        { key: 'name', label: 'Carrier Name', sortValue: ({ carrier }) => carrier?.name, shrink: true, className: 'overview-name-cell', render: ({ carrier }) => (carrier?.name ? <CopyableText copyText={carrier.name}>{carrier.name}</CopyableText> : '—') },
        { key: 'callsign', label: 'ID', sortValue: ({ carrier }) => carrier?.callsign, shrink: true, className: 'carrier-id-cell', render: ({ carrier }) => (carrier?.callsign ? <CopyableText copyText={carrier.callsign}>{carrier.callsign}</CopyableText> : '—') },
        {
          key: 'location',
          label: 'Current System/Body',
          sortValue: ({ carrier }) => carrier?.effective_location?.starSystem,
          shrink: true,
          className: 'carrier-location-cell',
          render: ({ carrier }) => renderSystemAndBody(carrier?.effective_location?.starSystem, carrier?.effective_location?.body),
        },
        {
          key: 'destination',
          label: 'Destination System/Body',
          sortValue: ({ carrier }) => carrier?.pending_jump?.starSystem,
          shrink: true,
          className: 'overview-gap-cell',
          render: ({ carrier }) => {
            const jumpState = getJumpState(carrier, now);
            if (jumpState?.kind === 'scheduled') {
              const lockLabel = getJumpLockLabel(jumpState.jump.departureTime, now);
              return (
                <>
                  {renderSystemAndBody(jumpState.jump.starSystem, jumpState.jump.body)}
                  {lockLabel && <span className="jump-status"> ({lockLabel})</span>}
                </>
              );
            }
            if (jumpState?.kind === 'cooldown') return <span className="jump-status">Cooldown</span>;
            return '—';
          },
        },
        {
          key: 'jumpTimer',
          label: 'Jump Timer',
          sortValue: ({ carrier }) => { const endsAt = getJumpState(carrier, now)?.endsAt; return endsAt ? Date.parse(endsAt) : null; },
          align: 'right',
          shrink: true,
          className: 'overview-wide-gap-cell',
          render: ({ carrier }) => {
            const jumpState = getJumpState(carrier, now);
            if (!jumpState) return '—';
            const countdown = formatCountdown(jumpState.endsAt, now);
            // Copied as a Discord relative timestamp, which shows "in X minutes" and counts down for each reader.
            const discordTimestamp = `<t:${Math.floor(Date.parse(jumpState.endsAt) / 1000)}:R>`;
            return <CopyableText copyText={discordTimestamp}>{countdown}</CopyableText>;
          },
        },
        { key: 'fuel', label: 'Fuel', sortValue: ({ carrier }) => carrier?.fuel_level, align: 'right', shrink: true, className: 'overview-gap-cell', render: ({ carrier }) => (carrier?.fuel_level == null ? '—' : `${formatNumber(carrier.fuel_level)} t`) },
        {
          key: 'freeSpace',
          label: 'Free Space',
          sortValue: ({ carrier }) => carrier?.space_usage?.FreeSpace,
          align: 'right',
          shrink: true,
          render: ({ carrier }) => (carrier?.space_usage?.FreeSpace == null ? '—' : `${formatNumber(carrier.space_usage.FreeSpace)} t`),
        },
        { key: 'note', label: 'Notes', sortValue: ({ status, carrier }) => (carrier ? carrier.note : status.commanderNote), wrap: true, className: 'carrier-note-cell', render: ({ status, carrier }) => (carrier
          ? <NoteCell note={carrier.note} saveUrl={`/api/carrier-notes/${carrier.carrier_id}`} subjectLabel={carrier.name ?? carrier.callsign ?? 'carrier'} />
          : <NoteCell note={status.commanderNote} saveUrl={`/api/commander-notes/${status.commanderId}`} subjectLabel={`CMDR ${status.commanderName}`} />) },
      ]}
    />
  );
}
