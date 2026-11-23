import { useState } from 'react';
import DataTable from '../../components/DataTable.jsx';
import RouteIcon from '../../components/RouteIcon.jsx';
import { Badge, KeyValueList, ProgressBar } from '../../components/ui.jsx';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber, formatRelativeTime, formatSystemName } from '../../format.js';
import { buildSpanshCarrierRouterUrl, isCarrierHelperInstalled, isSpanshHelperInstalled } from '../../spansh.js';
import SpanshRouteDialog from '../commanders/SpanshRouteDialog.jsx';
import { CARRIER_TYPE_BADGE_TONES, formatDockingAccess, formatTaxService, toTitleCase } from './carrier-display.jsx';

const MAX_CARRIER_FUEL = 1000;
// Crew roles left off the carrier cards' service list: the captain, and services every carrier has.
const HIDDEN_CREW_ROLES = new Set(['Captain', 'Commodities', 'CarrierFuel']);

export function CarrierCard({ carrier }) {
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
        <div className="badge-row carrier-card-badges">
          <CarrierRouteButton carrier={carrier} />
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
const SPANSH_CARRIER_TYPES = { FleetCarrier: 'fleet', SquadronCarrier: 'squadron' };

/**
 * Opens Spansh's Fleet Carrier Router for the carrier: starting where it is, as a fleet or squadron
 * carrier, with its used capacity (everything but free space: cargo, services and packs).
 */
function CarrierRouteButton({ carrier }) {
  const [dialogRequest, setDialogRequest] = useState(null);
  const location = carrier.effective_location;
  const spaceUsage = carrier.space_usage ?? {};
  const usedCapacity = Number.isFinite(spaceUsage.TotalCapacity) && Number.isFinite(spaceUsage.FreeSpace)
    ? spaceUsage.TotalCapacity - spaceUsage.FreeSpace
    : null;
  const source = location?.starSystem ? { name: location.starSystem, id64: location.systemAddress ?? undefined } : null;
  const unavailableReason = carrier.is_decommissioned ? 'This carrier has been decommissioned.' : !source ? 'Where this carrier is isn’t known.' : null;
  const request = {
    kind: 'carrier',
    label: carrier.name ?? carrier.callsign ?? 'the carrier',
    source,
    carrierType: SPANSH_CARRIER_TYPES[carrier.carrier_type] ?? 'fleet',
    usedCapacity,
  };
  const details = [
    location?.isAssumed && 'from where it jumped to (not yet confirmed)',
    usedCapacity === null && 'used capacity unknown',
  ].filter(Boolean).join('; ');

  const open = () => {
    if (!isCarrierHelperInstalled()) {
      setDialogRequest({ ...request, isOutdated: isSpanshHelperInstalled() });
      return;
    }
    window.open(buildSpanshCarrierRouterUrl(request), '_blank', 'noopener');
  };

  return (
    <>
      <button
        type="button"
        className="route-button"
        disabled={Boolean(unavailableReason)}
        title={unavailableReason ?? `Plot a route for this carrier on Spansh (opens a new tab)${details ? `; ${details}` : ''}`}
        aria-label={`Plot a route for ${request.label} on Spansh’s Fleet Carrier Router`}
        onClick={open}
      >
        <RouteIcon />
      </button>
      <SpanshRouteDialog request={dialogRequest} onClose={() => setDialogRequest(null)} />
    </>
  );
}

function PauseIcon() {
  return (
    <svg className="service-pause-icon" viewBox="0 0 8 8" width="8" height="8" aria-label="Suspended">
      <rect x="1" y="1" width="2" height="6" rx="0.5" fill="currentColor" />
      <rect x="5" y="1" width="2" height="6" rx="0.5" fill="currentColor" />
    </svg>
  );
}
