import { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { copyToClipboard } from '../../clipboard.js';
import DataTable from '../../components/DataTable.jsx';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../../components/ui.jsx';
import { useApi } from '../../hooks/use-api.js';
import { formatCredits, formatDateTime, formatNumber, formatSystemName } from '../../format.js';

/** Ships (with their full loadout), stored modules and vehicles. */
export default function FleetSection({ commanderId, picker, focusRequest }) {
  const fleetRequest = useApi(commanderId ? '/api/stats/fleet' : null, { commander: commanderId });
  const [selectedShipId, setSelectedShipId] = useState(null);
  const [isSoldShown, setIsSoldShown] = useState(false);

  // Asked to show a commander's ship (from their card): once their fleet has loaded, select the
  // ship they're flying and scroll to its loadout.
  const handledFocusRef = useRef(null);
  const isFleetReady = Boolean(fleetRequest.data) && !fleetRequest.isLoading;
  useEffect(() => {
    if (focusRequest?.target !== 'loadout' || focusRequest.commanderId !== commanderId || !isFleetReady) return;
    if (handledFocusRef.current === focusRequest.nonce) return;
    handledFocusRef.current = focusRequest.nonce;
    setSelectedShipId(null);
    requestAnimationFrame(() => document.querySelector('#commanders-fleet .ship-loadout')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [focusRequest, commanderId, isFleetReady]);

  return (
    <Section
      id="commanders-fleet"
      title="Fleet"
      description="Ships, their loadouts and engineering, stored modules and vehicles. A ship’s loadout is from the last time it was flown."
      actions={picker}
    >
      <LoadingState requestState={fleetRequest}>
        {({ ships, vehicles, hangars, ownedCounts, storedModules: storedModuleList }) => {
          const ownedShips = ships.filter((ship) => !ship.isSold);
          const shownShips = isSoldShown ? ships : ownedShips;
          const selectedShip = ships.find((ship) => ship.shipId === selectedShipId) ?? ownedShips.find((ship) => ship.isCurrent) ?? ownedShips[0];
          const fleetValue = ownedShips.reduce((total, ship) => total + (ship.value ?? 0), 0);
          const storedModules = storedModuleList.items;
          return (
            <>
              <StatGrid>
                <StatCard
                  label="Ships"
                  value={formatNumber(ownedShips.length)}
                  detail={ownedCounts?.ships !== null && ownedCounts?.ships !== undefined && ownedCounts.ships !== ownedShips.length
                    ? `The game counts ${formatNumber(ownedCounts.ships)}`
                    : `${formatNumber(ships.length - ownedShips.length)} sold or lost`}
                />
                <StatCard label="Fleet value" value={formatCredits(fleetValue)} tone="accent" />
                <StatCard label="Engineered modules" value={formatNumber(ownedShips.reduce((total, ship) => total + ship.engineeredCount, 0))} detail="on ships you own" />
                <StatCard label="Stored modules" value={formatNumber(storedModules.length)} detail={formatCredits(storedModules.reduce((total, item) => total + (item.value ?? 0), 0))} />
                <StatCard label="Vehicle hangars" value={formatNumber(hangars.length)} />
              </StatGrid>

              <div className="section-toolbar">
                <h3 className="subheading">Ships</h3>
                <label className="checkbox">
                  <input type="checkbox" checked={isSoldShown} onChange={(changeEvent) => setIsSoldShown(changeEvent.target.checked)} />
                  Show sold and lost ships
                </label>
              </div>
              <DataTable
                tableId="commanders.ships"
                rowKey="shipId"
                rows={shownShips}
                pageSize={10}
                pageResetKey={String(isSoldShown)}
                onRowClick={(ship) => setSelectedShipId(ship.shipId)}
                rowClassName={(ship) => [ship.shipId === selectedShip?.shipId && 'row-selected', ship.isSold && 'row-muted'].filter(Boolean).join(' ')}
                emptyMessage="No ships recorded yet."
                columns={[
                  {
                    key: 'shipTypeName',
                    label: 'Ship',
                    render: (ship) => (
                      <>
                        {ship.shipTypeName} {ship.isCurrent && <Badge tone="live">Current</Badge>} {ship.isSold && <Badge>Sold or lost</Badge>} {ship.isHot && <Badge tone="danger">Hot</Badge>}
                      </>
                    ),
                  },
                  { key: 'name', label: 'Name', render: (ship) => [ship.name, ship.ident].filter(Boolean).join(' · ') || '—' },
                  { key: 'location', label: 'Location', sortValue: (ship) => ship.location.starSystem ?? '', render: renderShipLocation },
                  { key: 'value', label: 'Value', align: 'right', render: (ship) => formatCredits(ship.value) },
                  { key: 'rebuy', label: 'Rebuy', align: 'right', render: (ship) => formatCredits(ship.rebuy) },
                  { key: 'maxJumpRange', label: 'Jump', align: 'right', render: (ship) => (ship.maxJumpRange ? `${ship.maxJumpRange.toFixed(1)} ly` : '—') },
                  { key: 'cargoCapacity', label: 'Cargo', align: 'right', render: (ship) => (ship.cargoCapacity === null ? '—' : `${formatNumber(ship.cargoCapacity)} t`) },
                  { key: 'engineeredCount', label: 'Engineered', align: 'right', render: (ship) => (ship.hasLoadout ? formatNumber(ship.engineeredCount) : '—') },
                ]}
              />
              <p className="muted small">Click a ship to see its loadout.</p>

              {selectedShip && <ShipLoadout key={selectedShip.shipId} ship={selectedShip} commanderId={commanderId} />}

              <div className="two-column">
                <section>
                  <h3 className="subheading">Vehicle hangars</h3>
                  <DataTable
                    tableId="commanders.hangars"
                    rowKey="key"
                    rows={hangars.map((hangar, index) => ({ ...hangar, key: index }))}
                    emptyMessage="No hangars on ships with a known loadout."
                    columns={[
                      { key: 'shipTypeName', label: 'Ship', render: (hangar) => hangar.shipName ? `${hangar.shipName} (${hangar.shipTypeName})` : hangar.shipTypeName },
                      { key: 'module', label: 'Hangar', render: (hangar) => `${hangar.module}${hangar.rating ? ` ${hangar.rating}` : ''}` },
                    ]}
                  />
                </section>
                <section>
                  <h3 className="subheading">Vehicles used</h3>
                  <DataTable
                    tableId="commanders.vehicles"
                    rowKey="key"
                    rows={vehicles.map((vehicle, index) => ({ ...vehicle, key: index }))}
                    emptyMessage="No SRVs or fighters used yet."
                    columns={[
                      { key: 'kind', label: 'Type', render: (vehicle) => (vehicle.kind === 'srv' ? 'SRV' : 'Fighter') },
                      { key: 'name', label: 'Vehicle' },
                      { key: 'loadout', label: 'Loadout', render: (vehicle) => vehicle.loadout ?? '—' },
                      { key: 'useCount', label: 'Launches', align: 'right' },
                      { key: 'lastUsedAt', label: 'Last used', render: (vehicle) => formatDateTime(vehicle.lastUsedAt) },
                    ]}
                  />
                </section>
              </div>

              <h3 className="subheading">Stored modules</h3>
              {storedModuleList.updatedAt && <p className="muted small">As of {formatDateTime(storedModuleList.updatedAt)} (updated when you visit outfitting)</p>}
              <DataTable
                tableId="commanders.storedModules"
                rowKey="key"
                rows={storedModules.map((item, index) => ({ ...item, key: index }))}
                pageSize={5}
                emptyMessage="No stored modules recorded."
                columns={[
                  { key: 'name', label: 'Module', render: (item) => (item.rating ? `${item.rating} ${item.name}` : item.name) },
                  { key: 'engineering', label: 'Engineering', render: (item) => (item.engineering ? `${item.engineering.blueprintName} G${item.engineering.level}` : '—') },
                  { key: 'starSystem', label: 'Location', render: (item) => (item.inTransit ? 'In transit' : formatSystemName(item.starSystem) ?? '—') },
                  { key: 'value', label: 'Value', align: 'right', render: (item) => formatCredits(item.value) },
                ]}
              />
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}

function renderShipLocation(ship) {
  if (ship.isCurrent) return 'With you';
  if (ship.isSold) return ship.soldAt ? `Gone since ${formatDateTime(ship.soldAt)}` : '—';
  const place = [ship.location.stationName, formatSystemName(ship.location.starSystem)].filter(Boolean).join(', ');
  return ship.location.isInTransit ? `In transit to ${place || 'you'}` : place || '—';
}

// Core internals in the outfitting screen's order, with short codes for the slot column.
const CORE_SLOTS = [
  ['Armour', 'BH', 'Bulkheads'],
  ['PowerPlant', 'PP', 'Power plant'],
  ['MainEngines', 'TH', 'Thrusters'],
  ['FrameShiftDrive', 'FSD', 'Frame shift drive'],
  ['LifeSupport', 'LS', 'Life support'],
  ['PowerDistributor', 'PD', 'Power distributor'],
  ['Radar', 'SN', 'Sensors'],
  ['FuelTank', 'FT', 'Fuel tank'],
];
const HARDPOINT_SIZE_CODES = { Huge: ['H', 4], Large: ['L', 3], Medium: ['M', 2], Small: ['S', 1] };
const LOADOUT_GROUPS = ['Core internals', 'Optional internals', 'Military', 'Hardpoints', 'Utility'];
const MAX_GRADE = 5;

/**
 * Where a module sits: its group, a short slot code ("L1" large hardpoint 1, "U2", "PP", "6" for a
 * size 6 optional slot), the full slot name and a sort order. Slots that don't fit a group are
 * built-in equipment.
 */
function classifySlot(module) {
  const slot = module.slotKey ?? '';
  const hardpoint = /^(Huge|Large|Medium|Small)Hardpoint(\d+)$/.exec(slot);
  if (hardpoint) {
    const [code, size] = HARDPOINT_SIZE_CODES[hardpoint[1]];
    return { group: 'Hardpoints', code: `${code}${hardpoint[2]}`, order: (5 - size) * 100 + Number(hardpoint[2]) };
  }
  const utility = /^TinyHardpoint(\d+)$/.exec(slot);
  if (utility) return { group: 'Utility', code: `U${utility[1]}`, order: Number(utility[1]) };
  const coreIndex = CORE_SLOTS.findIndex(([key]) => key === slot);
  if (coreIndex >= 0) return { group: 'Core internals', code: CORE_SLOTS[coreIndex][1], order: coreIndex };
  const optional = /^Slot(\d+)_Size(\d+)$/.exec(slot);
  if (optional) return { group: 'Optional internals', code: optional[2], order: (10 - Number(optional[2])) * 100 + Number(optional[1]) };
  // The Panther Clipper's extra cargo bays: optional slots sized by the rack fitted.
  const extraCargo = /^Cargo(\d+)$/.exec(slot);
  if (extraCargo) {
    const size = Number(/^(\d+)/.exec(module.rating ?? '')?.[1] ?? 0);
    return { group: 'Optional internals', code: size ? String(size) : 'C', order: (10 - size) * 100 + 90 + Number(extraCargo[1]) };
  }
  const military = /^Military(\d+)$/.exec(slot);
  if (military) return { group: 'Military', code: `MIL${military[1]}`, order: Number(military[1]) };
  return { group: 'Built-in', code: '', order: 0 };
}

function ShipLoadout({ ship, commanderId }) {
  const [selectedSlot, setSelectedSlot] = useState(null);
  const loadoutRequest = useApi(ship.hasLoadout ? '/api/stats/fleet/ship' : null, { commander: commanderId, ship: ship.shipId });
  const modules = (loadoutRequest.data?.modules ?? []).map((module) => ({ ...module, ...classifySlot(module) }));
  const groups = LOADOUT_GROUPS.map((group) => ({
    group,
    modules: modules.filter((module) => module.group === group).sort((first, second) => first.order - second.order),
  })).filter((group) => group.modules.length > 0);
  const builtIn = modules.filter((module) => module.group === 'Built-in');
  const selected = modules.find((module) => module.slotKey === selectedSlot) ?? null;

  // The export (EDSY/Coriolis links and SLEF) is only fetched when a button is used, then reused.
  const exportRef = useRef(null);
  const getExport = () => {
    exportRef.current ??= fetchJson(`/api/stats/fleet/export?commander=${commanderId}&ship=${ship.shipId}`).catch((error) => {
      exportRef.current = null;
      throw error;
    });
    return exportRef.current;
  };
  // A tab is opened straight away (browsers only allow that in the click itself), then sent on.
  const openExternal = async (urlKey) => {
    const newTab = window.open('', '_blank');
    try {
      const exported = await getExport();
      if (newTab) {
        newTab.opener = null;
        newTab.location.href = exported[urlKey];
      }
    } catch {
      newTab?.close();
    }
  };

  // The SLEF goes on the clipboard, to paste into Inara or another tool; the button says how it went.
  const [slefCopyStatus, setSlefCopyStatus] = useState(null);
  useEffect(() => {
    if (!slefCopyStatus) return undefined;
    const timer = setTimeout(() => setSlefCopyStatus(null), 2000);
    return () => clearTimeout(timer);
  }, [slefCopyStatus]);
  const copySlef = async () => {
    try {
      const exported = await getExport();
      setSlefCopyStatus((await copyToClipboard(JSON.stringify(exported.slef, null, 2))) ? 'copied' : 'failed');
    } catch {
      setSlefCopyStatus('failed');
    }
  };

  return (
    <div className="card ship-loadout">
      <header className="card-header ship-loadout-header">
        <div>
          <h3>{ship.name ? `${ship.name} (${ship.shipTypeName})` : ship.shipTypeName}{ship.ident && <span className="muted"> · {ship.ident}</span>}</h3>
          <div className="muted small">
            {ship.loadoutAt ? `Loadout as of ${formatDateTime(ship.loadoutAt)}` : 'Not flown since the journals began, so its loadout isn’t known.'}
          </div>
        </div>
        {ship.loadoutAt && (
          <div className="ship-loadout-actions">
            <button type="button" onClick={() => openExternal('edsyUrl')} title="Open this loadout in EDSY for full stats">Open in EDSY</button>
            <button type="button" onClick={() => openExternal('coriolisUrl')} title="Open this loadout in Coriolis for full stats">Open in Coriolis</button>
            <button type="button" onClick={copySlef} title="Copy the loadout to the clipboard in the Ship Loadout Exchange Format (for Inara and other tools)">
              {slefCopyStatus === 'copied' ? 'SLEF copied' : slefCopyStatus === 'failed' ? 'Copy failed' : 'Export SLEF'}
            </button>
          </div>
        )}
      </header>
      {ship.hasLoadout && loadoutRequest.data && (
        <>
          <StatGrid>
            <StatCard label="Hull + modules" value={formatCredits((ship.hullValue ?? 0) + (ship.modulesValue ?? 0))} detail={`Hull ${formatCredits(ship.hullValue)}`} />
            <StatCard label="Rebuy" value={formatCredits(ship.rebuy)} />
            <StatCard label="Jump range" value={ship.maxJumpRange ? `${ship.maxJumpRange.toFixed(2)} ly` : '—'} detail="unladen, full tank" />
            <StatCard label="Cargo" value={`${formatNumber(ship.cargoCapacity ?? 0)} t`} />
            <StatCard label="Fuel tank" value={ship.fuelCapacity ? `${formatNumber(ship.fuelCapacity)} t` : '—'} />
            <StatCard label="Mass" value={ship.unladenMass ? `${formatNumber(Math.round(ship.unladenMass))} t` : '—'} detail="unladen" />
          </StatGrid>
          <div className="loadout-layout">
            <div className="loadout-table" role="table" aria-label="Loadout">
              {groups.map(({ group, modules: groupModules }) => (
                <div key={group} role="rowgroup">
                  <div className="loadout-group-title" role="row">{group}</div>
                  {groupModules.map((module) => (
                    <LoadoutRow key={module.slotKey} module={module} isSelected={module.slotKey === selectedSlot} onSelect={() => setSelectedSlot(module.slotKey === selectedSlot ? null : module.slotKey)} />
                  ))}
                </div>
              ))}
              {builtIn.length > 0 && (
                <div className="loadout-built-in muted small">Built-in: {builtIn.map((module) => module.name).join(', ')}</div>
              )}
            </div>
            <ModuleDetails module={selected} />
          </div>
        </>
      )}
    </div>
  );
}

function LoadoutRow({ module, isSelected, onSelect }) {
  const engineering = module.engineering;
  return (
    <button type="button" role="row" className={`loadout-row ${isSelected ? 'loadout-row-selected' : ''} ${module.on ? '' : 'loadout-row-off'}`} onClick={onSelect} title={module.slot}>
      <span className="loadout-slot">{module.code}</span>
      <span className="loadout-rating">{module.rating ?? (module.hardpointSize ? `${module.hardpointSize}` : '')}</span>
      <span className="loadout-name">
        {module.name}
        {module.mount && <span className="loadout-mount"> {module.mount.toLowerCase()}</span>}
      </span>
      <span className={`loadout-engineering ${engineering ? '' : 'loadout-engineering-none'}`}>
        {engineering && (
          <>
            <span className="loadout-blueprint">{engineering.blueprintName}</span>
            <GradePips level={engineering.level} />
            {engineering.experimental && <span className="loadout-experimental-chip">{engineering.experimental}</span>}
          </>
        )}
      </span>
      <span className="loadout-status">
        {module.health !== null && Math.round(module.health * 100) < 100 && <Badge tone={module.health < 0.5 ? 'danger' : 'warning'} title={`Module health ${Math.round(module.health * 100)}% (damaged), when this loadout was logged`}>{Math.round(module.health * 100)}%</Badge>}
        {!module.on && <span className="loadout-off" title="Switched off">off</span>}
        {module.priority !== null && <span className="loadout-priority" title={`Power priority ${module.priority + 1}`}>{module.priority + 1}</span>}
      </span>
    </button>
  );
}

function GradePips({ level }) {
  return (
    <span className="grade-pips" title={`Grade ${level}`} aria-label={`Grade ${level}`}>
      {Array.from({ length: MAX_GRADE }, (unused, index) => <span key={index} className={index < level ? 'grade-pip grade-pip-on' : 'grade-pip'} />)}
    </span>
  );
}

/** The selected module's details and engineering changes, beside the loadout. */
function ModuleDetails({ module }) {
  if (!module) {
    return <aside className="module-details module-details-empty muted small">Select a module to see its details and engineering.</aside>;
  }
  const engineering = module.engineering;
  return (
    <aside className="module-details">
      <div className="module-details-slot muted small">{module.slot}</div>
      <h4>{module.rating ? `${module.rating} ` : ''}{module.name}{module.mount ? ` (${module.mount.toLowerCase()})` : ''}</h4>
      <dl className="module-details-facts">
        {module.value !== null && module.value !== undefined && <div><dt>Value</dt><dd>{formatCredits(module.value)}</dd></div>}
        <div><dt>Power</dt><dd>{module.on ? 'On' : 'Off'}{module.priority !== null ? ` · priority ${module.priority + 1}` : ''}</dd></div>
        {module.health !== null && <div><dt>Health</dt><dd>{Math.round(module.health * 100)}%</dd></div>}
        {module.ammo && <div><dt>Ammo</dt><dd>{formatNumber(module.ammo.clip)} / {formatNumber(module.ammo.hopper)}</dd></div>}
      </dl>
      {engineering ? (
        <>
          <div className="module-details-engineering">
            <span className="loadout-blueprint">{engineering.blueprintName}</span>
            <GradePips level={engineering.level} />
            {engineering.quality !== null && <span className="muted small">{Math.round(engineering.quality * 100)}% quality</span>}
          </div>
          {engineering.experimental && <div className="loadout-experimental-chip module-details-experimental">{engineering.experimental}</div>}
          {engineering.engineer && <div className="muted small">Engineered by {engineering.engineer}</div>}
          {engineering.modifiers?.length > 0 && (
            <table className="modifier-table">
              <thead>
                <tr><th>Stat</th><th>Base</th><th>Now</th><th>Change</th></tr>
              </thead>
              <tbody>
                {engineering.modifiers.map((modifier) => <ModifierRow key={modifier.label} modifier={modifier} />)}
              </tbody>
            </table>
          )}
        </>
      ) : <div className="muted small">Not engineered.</div>}
    </aside>
  );
}

function ModifierRow({ modifier }) {
  const { value, originalValue } = modifier;
  const isNumeric = typeof value === 'number' && typeof originalValue === 'number';
  const change = isNumeric && originalValue !== 0 ? (value - originalValue) / Math.abs(originalValue) : null;
  const isBetter = change !== null && (modifier.lessIsGood ? change < 0 : change > 0);
  return (
    <tr>
      <td>{modifier.name}</td>
      <td className="numeric">{isNumeric ? formatStat(originalValue) : '—'}</td>
      <td className="numeric">{isNumeric ? formatStat(value) : String(value)}</td>
      <td className={`numeric ${change ? (isBetter ? 'modifier-better' : 'modifier-worse') : ''}`}>
        {change ? `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}%` : '—'}
      </td>
    </tr>
  );
}

function formatStat(value) {
  return Math.abs(value) >= 100 ? formatNumber(Math.round(value)) : Number(value.toFixed(3)).toString();
}


