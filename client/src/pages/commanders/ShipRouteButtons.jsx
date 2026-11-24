import { useState } from 'react';
import RouteIcon from '../../components/RouteIcon.jsx';
import { formatShipName } from '../../format.js';
import { fetchShipExport } from '../../ship-export.js';
import { buildSpanshPlotterUrl, buildWaypointPlannerUrl, isSpanshHelperInstalled, isWaypointHelperInstalled } from '../../spansh.js';
import SpanshRouteDialog from './SpanshRouteDialog.jsx';

/**
 * A ship's two route buttons: Spansh's Galaxy Plotter (its build, starting where it is) and the
 * Wanderer's Toolbox Multi Waypoint Planner (starting where it is, then a pasted list of systems).
 * When the userscript that fills those pages in isn't installed (or is too old), a button opens
 * the setup dialog instead.
 *
 * ship: { shipId, shipTypeName, name, loadoutAt, isSold }
 * source: the system the route starts from ({ name, id64? }), or null when unknown
 */
export default function ShipRouteButtons({ commanderId, ship, source, className = '' }) {
  const [dialogRequest, setDialogRequest] = useState(null);
  const label = formatShipName(ship.shipTypeName, ship.name);

  const plotRoute = async () => {
    const request = { label, source, getExport: () => fetchShipExport(commanderId, ship) };
    if (!isSpanshHelperInstalled()) {
      setDialogRequest(request);
      return;
    }
    // The tab is opened in the click itself (browsers block it later), then sent on.
    const newTab = window.open('', '_blank');
    try {
      const { slef } = await request.getExport();
      if (newTab) {
        newTab.opener = null;
        newTab.location.href = buildSpanshPlotterUrl({ source, slef, label });
      }
    } catch {
      newTab?.close();
    }
  };

  // The userscript adds the start, then waits for a pasted list and optimizes the route.
  const planWaypoints = () => {
    if (!isWaypointHelperInstalled()) {
      setDialogRequest({ kind: 'waypoints', label, source, isOutdated: isSpanshHelperInstalled() });
      return;
    }
    window.open(buildWaypointPlannerUrl({ start: source, label }), '_blank', 'noopener');
  };

  const plotUnavailable = ship.isSold ? 'This ship is sold or lost.' : !ship.loadoutAt ? 'Not flown since the journals began, so its build isn’t known.' : null;
  const planUnavailable = ship.isSold ? 'This ship is sold or lost.' : !source?.name ? 'Where this ship is isn’t known.' : null;
  return (
    // Clicks here (and in the dialog) stay here, so a table row or card around them doesn't react too.
    <span className={`route-buttons ${className}`} onClick={(clickEvent) => clickEvent.stopPropagation()}>
      <button
        type="button"
        className="route-button"
        disabled={Boolean(plotUnavailable)}
        title={plotUnavailable ?? 'Plot a route for this ship on Spansh (opens a new tab)'}
        aria-label={`Plot a route for ${label} on Spansh`}
        onClick={plotRoute}
      >
        <RouteIcon />
      </button>
      <button
        type="button"
        className="route-button"
        disabled={Boolean(planUnavailable)}
        title={planUnavailable ?? 'Plan a route through several systems from here (Multi Waypoint Planner; paste the list when it opens)'}
        aria-label={`Plan a multi-waypoint route from ${label}’s system`}
        onClick={planWaypoints}
      >
        <WaypointsIcon />
      </button>
      <SpanshRouteDialog request={dialogRequest} onClose={() => setDialogRequest(null)} />
    </span>
  );
}

/**
 * A long route: from a start, snaking back and forth through several stops to a flag at the end,
 * so it reads apart from the Spansh button's three-node route beside it.
 */
function WaypointsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5H15.5a3 3 0 0 0 0-6H8.5a3 3 0 0 1 0-6H17" fill="none" />
      <circle cx="4" cy="19.5" r="2.3" stroke="none" />
      <circle cx="12" cy="13.5" r="1.6" stroke="none" />
      <circle cx="12" cy="7.5" r="1.6" stroke="none" />
      <path d="M18 7.5V2.5" fill="none" />
      <path d="M18 2.8h3.6l-1 1.5 1 1.5H18z" strokeWidth="1.2" />
    </svg>
  );
}
