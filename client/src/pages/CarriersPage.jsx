import { useEffect, useState } from 'react';
import { putJson } from '../api.js';
import CopyableText from '../components/CopyableText.jsx';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { Badge, KeyValueList, LoadingState, ProgressBar, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber, formatRelativeTime, formatSystemName } from '../format.js';

const MAX_CARRIER_FUEL = 1000;
const CARD_SORT_STORAGE_KEY = 'carriers.cardSort';
const SHOW_CARRIERLESS_STORAGE_KEY = 'carriers.showCommandersWithoutCarrier';
const SHOW_UNOWNED_STORAGE_KEY = 'carriers.showUnownedCarriers';
const MAX_NOTE_LENGTH = 200;
const CARRIER_TYPE_BADGE_TONES = { FleetCarrier: 'fleet-carrier', SquadronCarrier: 'squadron-carrier' };
// The journal's lowercase DockingAccess values and TaxRate_* service names, for display.
const DOCKING_ACCESS_LABELS = { squadronfriends: 'Squadron & Friends' };
const TAX_SERVICE_LABELS = { pioneersupplies: 'Pioneer Supplies' };
// Crew roles left off the carrier cards' service list: the captain, and services every carrier has.
const HIDDEN_CREW_ROLES = new Set(['Captain', 'Commodities', 'CarrierFuel']);

function toTitleCase(text) {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function formatDockingAccess(dockingAccess) {
  return DOCKING_ACCESS_LABELS[dockingAccess] ?? toTitleCase(dockingAccess);
}

function formatTaxService(service) {
  return TAX_SERVICE_LABELS[service] ?? toTitleCase(service);
}

/** Card sort options. Carriers with an unknown age or activity time are listed last. */
const CARD_SORTS = {
  age: { label: 'Age (Oldest First)', compare: (first, second) => compareTimestamps(first.acquired_at, second.acquired_at, 'asc') },
  name: { label: 'Name', compare: (first, second) => getCarrierLabel(first).localeCompare(getCarrierLabel(second), undefined, { sensitivity: 'base' }) },
  activity: { label: 'Activity (Most Recent First)', compare: (first, second) => compareTimestamps(first.updated_at, second.updated_at, 'desc') },
};

function compareTimestamps(first, second, order) {
  if (!first || !second) return Number(!first) - Number(!second);
  return order === 'asc' ? first.localeCompare(second) : second.localeCompare(first);
}

function getCarrierLabel(carrier) {
  return carrier.name ?? carrier.callsign ?? '';
}

/**
 * One overview row per owned carrier, oldest purchase first (first seen when the purchase isn't in the
 * journals), then one row per commander without a carrier.
 */
function buildOverviewRows(commanderStatuses, carriers) {
  return commanderStatuses
    .flatMap((status) => {
      const ownedCarriers = [...status.fleetCarrierIds, ...status.squadronCarrierIds]
        .map((carrierId) => carriers.find((carrier) => carrier.carrier_id === carrierId));
      if (ownedCarriers.length === 0) {
        return [{ rowKey: `${status.commanderId}`, status, carrier: null }];
      }
      return ownedCarriers.map((carrier) => ({ rowKey: `${status.commanderId}-${carrier.carrier_id}`, status, carrier }));
    })
    .sort((first, second) => compareTimestamps(first.carrier?.acquired_at, second.carrier?.acquired_at, 'asc'));
}

function readStoredFlag(storageKey) {
  try {
    return localStorage.getItem(storageKey) === 'true';
  } catch {
    return false;
  }
}

function storeFlag(storageKey, value) {
  try {
    localStorage.setItem(storageKey, String(value));
  } catch {
    // Storage may be unavailable; the choice still applies for this session.
  }
}

/**
 * The carrier's jump state, with the time its countdown runs to:
 * - scheduled: a requested jump that hasn't departed (the destination is pending_jump)
 * - cooldown: 4:50 after a jump departs, 1 minute after one is cancelled
 */
function getJumpState(carrier, now) {
  const pendingJump = carrier?.pending_jump;
  if (pendingJump?.departureTime && Date.parse(pendingJump.departureTime) > now) {
    return { kind: 'scheduled', jump: pendingJump, endsAt: pendingJump.departureTime };
  }
  if (carrier?.cooldown_ends_at && Date.parse(carrier.cooldown_starts_at) <= now && Date.parse(carrier.cooldown_ends_at) > now) {
    return { kind: 'cooldown', endsAt: carrier.cooldown_ends_at };
  }
  return null;
}

/** Lock stages before a jump departs, as the game shows them (most restrictive first). */
const JUMP_LOCK_STAGES = [
  { label: 'Pad Locked', beforeDepartureMs: (3 * 60 + 20) * 1000 },
  { label: 'Jump Locked', beforeDepartureMs: 10 * 60 * 1000 },
];

function getJumpLockLabel(departureTime, now) {
  const msUntilDeparture = Date.parse(departureTime) - now;
  return JUMP_LOCK_STAGES.find((stage) => msUntilDeparture <= stage.beforeDepartureMs)?.label ?? null;
}

/** Whole seconds remaining, rounded up like the game's timers. */
function formatCountdown(targetTimestamp, now) {
  const totalSeconds = Math.max(0, Math.ceil((Date.parse(targetTimestamp) - now) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** The squadron ID (e.g. PBNS), copied on click; the full name shows on hover. "?" when the squadron's carrier hasn't been seen. */
function renderSquadronId({ squadronId, squadronName }) {
  if (!squadronName) return '—';
  if (!squadronId) return <span title={squadronName}>?</span>;
  return <CopyableText copyText={squadronId} title={squadronName}>{squadronId}</CopyableText>;
}

/**
 * System and (if any) body. Body names usually start with the system name ("Synuefe NL-N c23-4 A"),
 * so only the remaining part is shown; a body named exactly like the system is its main star.
 * Clicking copies only the system name.
 */
function renderSystemAndBody(starSystem, body) {
  if (!starSystem) return '—';
  const bodySuffix = body === starSystem ? 'Star'
    : body?.startsWith(starSystem) ? body.slice(starSystem.length).trim() : body;
  return (
    <CopyableText copyText={starSystem}>
      {formatSystemName(starSystem)}
      {bodySuffix && <span className="muted small"> · {bodySuffix}</span>}
    </CopyableText>
  );
}

const COUNTDOWN_UPDATE_INTERVAL_MS = 200;

/** The current time, updated every 200ms while isActive(now) is true (for countdowns). */
function useCurrentTime(isActive) {
  const [now, setNow] = useState(Date.now);
  const isEnabled = isActive(now);
  useEffect(() => {
    if (!isEnabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_UPDATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isEnabled]);
  return now;
}

/**
 * A carrier's or commander's note. Double-clicking (or Enter when focused) edits it in place: Enter or leaving the field saves, Escape cancels,
 * and saving an empty note removes it.
 */
function NoteCell({ note, saveUrl, subjectLabel }) {
  const [draftNote, setDraftNote] = useState(null); // null while not editing
  // A just-saved note, shown until refreshed data replaces the note it was edited from.
  const [pendingSave, setPendingSave] = useState(null); // { note, previousNote }
  const [saveError, setSaveError] = useState(null);
  const savedNote = note ?? '';
  const displayedNote = pendingSave?.previousNote === savedNote ? pendingSave.note : savedNote;

  const saveNote = async () => {
    const newNote = draftNote.trim();
    setDraftNote(null);
    if (newNote === displayedNote) return;
    setPendingSave({ note: newNote, previousNote: savedNote });
    setSaveError(null);
    try {
      await putJson(saveUrl, { note: newNote });
    } catch (error) {
      setPendingSave(null);
      setSaveError(error.message);
    }
  };

  if (draftNote !== null) {
    return (
      <input
        className="note-input"
        value={draftNote}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="Add a note…"
        aria-label={`Note for ${subjectLabel}`}
        autoFocus
        onChange={(changeEvent) => setDraftNote(changeEvent.target.value)}
        onBlur={saveNote}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Enter') keyEvent.currentTarget.blur();
          if (keyEvent.key === 'Escape') setDraftNote(null);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={displayedNote ? 'note-button' : 'note-button note-button-empty'}
      title={saveError ? `Couldn't save the note: ${saveError}` : 'Double-click to edit the note'}
      onDoubleClick={() => setDraftNote(displayedNote)}
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault();
          setDraftNote(displayedNote);
        }
      }}
    >
      {displayedNote || 'Add note'}
      {saveError && <span className="note-error"> (not saved)</span>}
    </button>
  );
}

function CarrierOverviewTable({ commanderStatuses, carriers, includeCommandersWithoutCarrier }) {
  const allRows = buildOverviewRows(commanderStatuses, carriers);
  // Hidden commanders stay in the table, collapsed, so column widths don't change when they're shown.
  const hasVisibleRows = allRows.some((row) => row.carrier || includeCommandersWithoutCarrier);
  const overviewRows = hasVisibleRows ? allRows : [];
  const now = useCurrentTime((currentTime) => overviewRows.some((row) => getJumpState(row.carrier, currentTime)));

  return (
    <DataTable
      tableId="carriers.overview"
      rowKey="rowKey"
      rows={overviewRows}
      rowClassName={(row) => (!row.carrier && !includeCommandersWithoutCarrier ? 'collapsed-row' : undefined)}
      emptyMessage={includeCommandersWithoutCarrier ? 'No commanders.' : 'No commander owns a carrier.'}
      columns={[
        { key: 'commander', label: 'Commander', sortValue: ({ status }) => status.commanderName, shrink: true, className: 'overview-name-cell', render: ({ status }) => <CopyableText copyText={status.commanderName}>CMDR {status.commanderName}</CopyableText> },
        { key: 'squadron', label: 'Squadron', sortValue: ({ status }) => status.squadronId, shrink: true, render: ({ status }) => renderSquadronId(status) },
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

function readStoredCardSort() {
  try {
    const storedSort = localStorage.getItem(CARD_SORT_STORAGE_KEY);
    return CARD_SORTS[storedSort] ? storedSort : 'age';
  } catch {
    return 'age';
  }
}

export default function CarriersPage({ commanderFilter }) {
  const carriersRequest = useApi('/api/stats/carriers', { commander: commanderFilter }, ['stats', 'notes']);
  const [cardSort, setCardSort] = useState(readStoredCardSort);
  const [showCommandersWithoutCarrier, setShowCommandersWithoutCarrier] = useState(() => readStoredFlag(SHOW_CARRIERLESS_STORAGE_KEY));

  const [showUnownedCarriers, setShowUnownedCarriers] = useState(() => readStoredFlag(SHOW_UNOWNED_STORAGE_KEY));

  const changeShowCommandersWithoutCarrier = (isShown) => {
    setShowCommandersWithoutCarrier(isShown);
    storeFlag(SHOW_CARRIERLESS_STORAGE_KEY, isShown);
  };

  const changeShowUnownedCarriers = (isShown) => {
    setShowUnownedCarriers(isShown);
    storeFlag(SHOW_UNOWNED_STORAGE_KEY, isShown);
  };

  const changeCardSort = (sortName) => {
    setCardSort(sortName);
    try {
      localStorage.setItem(CARD_SORT_STORAGE_KEY, sortName);
    } catch {
      // Storage may be unavailable; the choice still applies for this session.
    }
  };

  return (
    <>
      <LoadingState requestState={carriersRequest}>
        {({ carriers, commanderStatuses }) => {
          const activeCarriers = carriers.filter((carrier) => !carrier.is_decommissioned);
          // Only carriers a commander owns; squadron carriers they're merely linked to aren't theirs to spend.
          const ownedCarrierIds = new Set(commanderStatuses.flatMap((status) => [...status.fleetCarrierIds, ...status.squadronCarrierIds]));
          // Unowned carriers (linked squadron carriers, decommissioned ones) are hidden unless toggled on,
          // and then come after the owned ones, each group in the chosen order.
          const cardCarriers = showUnownedCarriers ? carriers : carriers.filter((carrier) => ownedCarrierIds.has(carrier.carrier_id));
          const sortedCarriers = [...cardCarriers].sort((first, second) => (
            Number(ownedCarrierIds.has(second.carrier_id)) - Number(ownedCarrierIds.has(first.carrier_id))
            || CARD_SORTS[cardSort].compare(first, second)
          ));
          const ownedCarriers = activeCarriers.filter((carrier) => ownedCarrierIds.has(carrier.carrier_id));
          const totalBalance = ownedCarriers.reduce((total, carrier) => total + (carrier.finance?.carrierBalance ?? 0), 0);
          return (
            <>
              <Section
                title="Overview"
                description="Click a commander, squadron, carrier name, ID, system or jump timer to copy it. Double-click a note to edit it."
                actions={(
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showCommandersWithoutCarrier}
                      onChange={(changeEvent) => changeShowCommandersWithoutCarrier(changeEvent.target.checked)}
                    />
                    Show Commanders With No Carrier
                  </label>
                )}
              >
                <StatGrid>
                  <StatCard label="Fleet carriers" value={ownedCarriers.filter((carrier) => carrier.carrier_type === 'FleetCarrier').length} />
                  <StatCard label="Squadron carriers" value={ownedCarriers.filter((carrier) => carrier.carrier_type === 'SquadronCarrier').length} />
                  <StatCard label="Combined balance" value={formatCredits(totalBalance)} />
                  <StatCard label="Commanders with carriers" value={`${commanderStatuses.filter((status) => status.carrierStatus !== 'None').length} / ${commanderStatuses.length}`} />
                </StatGrid>
                <CarrierOverviewTable commanderStatuses={commanderStatuses} carriers={carriers} includeCommandersWithoutCarrier={showCommandersWithoutCarrier} />
              </Section>

              <Section
                id="carrier-details"
                title="Carriers"
                actions={(
                  <>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={showUnownedCarriers}
                        onChange={(changeEvent) => changeShowUnownedCarriers(changeEvent.target.checked)}
                      />
                      Show Unowned Carriers
                    </label>
                    <select value={cardSort} onChange={(changeEvent) => changeCardSort(changeEvent.target.value)} aria-label="Sort carriers">
                      {Object.entries(CARD_SORTS).map(([sortName, sortOption]) => <option key={sortName} value={sortName}>Sort: {sortOption.label}</option>)}
                    </select>
                  </>
                )}
              >
                {sortedCarriers.length === 0 ? <div className="notice">{carriers.length === 0 ? 'No carriers found.' : 'No owned carriers found.'}</div> : (
                  <div className="card-grid card-grid-wide">
                    {sortedCarriers.map((carrier) => <CarrierCard key={carrier.carrier_id} carrier={carrier} />)}
                  </div>
                )}
              </Section>
            </>
          );
        }}
      </LoadingState>

      <CarrierHistorySection commanderFilter={commanderFilter} />
    </>
  );
}

function CarrierCard({ carrier }) {
  const finance = carrier.finance ?? {};
  const spaceUsage = carrier.space_usage ?? {};
  const location = carrier.effective_location;
  // Only installed services; the journal can't tell removed ones from ones that were never installed.
  const crewServices = Object.entries(carrier.crew_services ?? {})
    .filter(([role, crewService]) => !HIDDEN_CREW_ROLES.has(role) && crewService.activated);
  const tradeOrders = Object.values(carrier.trade_orders ?? {});

  return (
    <article className="card carrier-card">
      <header className="card-header">
        <div>
          <h3>{carrier.name ?? 'Unnamed Carrier'}</h3>
          <div className="muted small">{carrier.callsign ?? '—'} · {carrier.commanders.map((link) => `CMDR ${link.commander_name} (${link.relationship})`).join(', ')}</div>
        </div>
        <div className="badge-row">
          <Badge tone={CARRIER_TYPE_BADGE_TONES[carrier.carrier_type] ?? 'neutral'}>{carrier.carrier_type_label ?? '?'}</Badge>
          {carrier.is_decommissioned && <Badge tone="danger">Decommissioned</Badge>}
          {!carrier.is_decommissioned && carrier.pending_decommission === 1 && <Badge tone="warning">Decommissioning</Badge>}
        </div>
      </header>

      <div className="carrier-columns">
        <KeyValueList items={[
          { label: 'Location', value: location?.starSystem ? `${formatSystemName(location.starSystem)}${location.isAssumed ? ' (Jumped, Unconfirmed)' : ''}` : null },
          { label: 'Location Since', value: location?.since ? formatRelativeTime(location.since) : null },
          carrier.pending_jump && !location?.isAssumed && {
            label: 'Pending Jump',
            value: `${formatSystemName(carrier.pending_jump.body ?? carrier.pending_jump.starSystem)} · Departs ${formatDateTime(carrier.pending_jump.departureTime)}`,
          },
          { label: 'Docking', value: carrier.docking_access ? `${formatDockingAccess(carrier.docking_access)}${carrier.allow_notorious ? ' (Notorious Allowed)' : ''}` : null },
          { label: 'Jump Range', value: carrier.jump_range_current ? `${formatNumber(carrier.jump_range_current)} / ${formatNumber(carrier.jump_range_max)} ly` : null },
          carrier.decommission_time && { label: 'Decommission At', value: formatDateTime(carrier.decommission_time) },
          { label: 'Stats Updated', value: carrier.stats_updated_at ? formatRelativeTime(carrier.stats_updated_at) : null },
        ]} />

        <KeyValueList items={[
          { label: 'Balance', value: formatFullCredits(finance.carrierBalance) },
          { label: 'Available', value: formatFullCredits(finance.availableBalance) },
          { label: 'Reserve', value: finance.reserveBalance === undefined ? null : `${formatFullCredits(finance.reserveBalance)} (${finance.reservePercent ?? 0}%)` },
          finance.taxRates && { label: 'Tax Rates', value: Object.entries(finance.taxRates).map(([service, rate]) => `${formatTaxService(service)} ${rate}%`).join(', ') },
          !carrier.purchase_price && carrier.acquired_at && { label: 'First Seen', value: formatDateTime(carrier.acquired_at) },
          carrier.purchase_price && { label: 'Purchased', value: `${formatDateTime(carrier.bought_at)} for ${formatCredits(carrier.purchase_price)}` },
        ]} />
      </div>

      <div className="meter-row">
        <span className="meter-label">Fuel</span>
        <ProgressBar value={carrier.fuel_level ?? 0} max={MAX_CARRIER_FUEL} />
        <span className="meter-value">{formatNumber(carrier.fuel_level)} / {MAX_CARRIER_FUEL} t</span>
      </div>
      {spaceUsage.TotalCapacity > 0 && (
        <div className="meter-row">
          <span className="meter-label">Space</span>
          <ProgressBar value={spaceUsage.TotalCapacity - spaceUsage.FreeSpace} max={spaceUsage.TotalCapacity} />
          <span className="meter-value">{formatNumber(spaceUsage.FreeSpace)} t Free · Cargo {formatNumber(spaceUsage.Cargo)} t</span>
        </div>
      )}

      {crewServices.length > 0 && (
        <div className="service-list">
          {crewServices.map(([role, crewService]) => {
            const serviceState = crewService.enabled ? 'active' : 'paused';
            return (
              <span
                key={role}
                className={`service-chip service-${serviceState}`}
                title={serviceState === 'paused' ? `Suspended${crewService.crewName ? ` · ${crewService.crewName}` : ''}` : crewService.crewName ?? 'Active'}
              >
                {serviceState === 'paused' && <PauseIcon />}
                {role.replace(/([a-z])([A-Z])/g, '$1 $2')}
              </span>
            );
          })}
        </div>
      )}

      {tradeOrders.length > 0 && (
        <details className="details">
          <summary>{tradeOrders.length} Trade Order{tradeOrders.length === 1 ? '' : 's'}</summary>
          <DataTable
            tableId="carriers.tradeOrders"
            rowKey="commodity"
            rows={tradeOrders}
            columns={[
              { key: 'orderType', label: 'Order', render: (order) => <Badge tone={order.orderType === 'buy' ? 'info' : 'accent'}>{toTitleCase(order.orderType)}</Badge> },
              { key: 'commodity', label: 'Commodity' },
              { key: 'quantity', label: 'Quantity', align: 'right' },
              { key: 'price', label: 'Price', align: 'right', render: (order) => formatFullCredits(order.price) },
              { key: 'updatedAt', label: 'Set', render: (order) => formatRelativeTime(order.updatedAt) },
            ]}
          />
        </details>
      )}
    </article>
  );
}

/** Two small bars marking a suspended crew service. */
function PauseIcon() {
  return (
    <svg className="service-pause-icon" viewBox="0 0 8 8" width="8" height="8" aria-label="Suspended">
      <rect x="1" y="1" width="2" height="6" rx="0.5" fill="currentColor" />
      <rect x="5" y="1" width="2" height="6" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function CarrierHistorySection({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const filterParams = { commander: commanderFilter, ...queryParams };
  const jumpTableState = useTableState({ tableId: 'carriers.jumps', defaultSort: 'timestamp', pageSize: 25, resetKey: JSON.stringify(filterParams) });
  const transactionTableState = useTableState({ tableId: 'carriers.bankTransfers', defaultSort: 'timestamp', pageSize: 25, resetKey: JSON.stringify(filterParams) });

  const jumpsRequest = useApi('/api/stats/carriers/jumps', { ...filterParams, ...jumpTableState.queryParams });
  const transactionsRequest = useApi('/api/stats/carriers/transactions', { ...filterParams, ...transactionTableState.queryParams });

  return (
    <Section title="Carrier History">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search carrier or system…" />
      <h3 id="carrier-jump-history" className="subheading">Jumps</h3>
      <DataTable
        tableId="carriers.jumps"
        isLoading={jumpsRequest.isLoading}
        rows={jumpsRequest.data?.rows ?? []}
        sorting={jumpTableState.sorting}
        pagination={jumpsRequest.data && { ...jumpsRequest.data, onOffsetChange: jumpTableState.onOffsetChange }}
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (jump) => formatDateTime(jump.timestamp) },
          { key: 'carrier_name', label: 'Carrier', render: (jump) => `${jump.carrier_name ?? '—'} (${jump.callsign ?? '?'})` },
          { key: 'jump_event', label: 'Event', render: (jump) => <Badge tone={{ requested: 'info', cancelled: 'warning', arrived: 'live' }[jump.jump_event]}>{jump.jump_event}</Badge> },
          { key: 'star_system', label: 'System', render: (jump) => formatSystemName(jump.body ?? jump.star_system) ?? '—' },
          { key: 'departure_time', label: 'Departure', render: (jump) => formatDateTime(jump.departure_time) },
          { key: 'commander_name', label: 'By' },
        ]}
      />
      <h3 id="carrier-bank-history" className="subheading">Bank transfers</h3>
      <DataTable
        tableId="carriers.bankTransfers"
        isLoading={transactionsRequest.isLoading}
        rows={transactionsRequest.data?.rows ?? []}
        sorting={transactionTableState.sorting}
        pagination={transactionsRequest.data && { ...transactionsRequest.data, onOffsetChange: transactionTableState.onOffsetChange }}
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (transaction) => formatDateTime(transaction.timestamp) },
          { key: 'carrier_name', label: 'Carrier', render: (transaction) => `${transaction.carrier_name ?? '—'} (${transaction.callsign ?? '?'})` },
          { key: 'transaction_type', label: 'Type', render: (transaction) => <Badge tone={transaction.transaction_type === 'deposit' ? 'live' : 'warning'}>{transaction.transaction_type}</Badge> },
          { key: 'amount', label: 'Amount', align: 'right', sortKey: 'amount', render: (transaction) => formatFullCredits(transaction.amount) },
          { key: 'carrier_balance', label: 'Carrier balance', align: 'right', render: (transaction) => formatCredits(transaction.carrier_balance) },
          { key: 'commander_name', label: 'Commander' },
        ]}
      />
    </Section>
  );
}
