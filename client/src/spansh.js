/**
 * Opening route planners with details filled in: Spansh's Galaxy Plotter (a ship's build and
 * starting system), Spansh's Fleet Carrier Router (a carrier's system, type and used capacity) and
 * the Wanderer's Toolbox Multi Waypoint Planner (the starting system, then a pasted list of systems).
 *
 * None of these pages takes anything from its address, so the details travel in the link's #
 * fragment (which browsers never send to a server) and a userscript the user installs, served from
 * /edjt-spansh.user.js, fills in the form. On the dashboard the script marks the page with its
 * version, so the dashboard can tell whether it's installed and new enough.
 */
export const SPANSH_PLOTTER_URL = 'https://spansh.co.uk/exact-plotter';
export const SPANSH_CARRIER_ROUTER_URL = 'https://www.spansh.co.uk/fleet-carrier';
export const WAYPOINT_PLANNER_URL = 'https://wanderer-toolbox.com/useful-tools/multi-waypoint/';
export const SPANSH_USERSCRIPT_PATH = '/edjt-spansh.user.js';
// The first userscript versions that fill in the waypoint planner (and optimize the route), and the
// Fleet Carrier Router.
const WAYPOINT_HELPER_VERSION = [1, 2, 0];
const CARRIER_HELPER_VERSION = [1, 3, 0];

/** The userscript's version on this page (it runs on localhost and private LAN addresses), or null. */
export function getHelperVersion() {
  return document.documentElement.dataset.edjtSpansh ?? null;
}

/** Whether the userscript has run on this page. */
export function isSpanshHelperInstalled() {
  return Boolean(getHelperVersion());
}

/** Whether the userscript on this page is at least `minimum` ([major, minor, patch]). */
function isHelperAtLeast(minimum) {
  const version = getHelperVersion();
  if (!version) return false;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < minimum.length; index++) {
    if ((parts[index] ?? 0) !== minimum[index]) return (parts[index] ?? 0) > minimum[index];
  }
  return true;
}

/** Whether the userscript on this page is new enough to fill in the waypoint planner. */
export function isWaypointHelperInstalled() {
  return isHelperAtLeast(WAYPOINT_HELPER_VERSION);
}

/** Whether the userscript on this page is new enough to fill in the Fleet Carrier Router. */
export function isCarrierHelperInstalled() {
  return isHelperAtLeast(CARRIER_HELPER_VERSION);
}

/** A request as a URL-safe base64 fragment value. */
function encodeRequest(request) {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The plotter link carrying the starting system ({ name, id64? }), the SLEF and a label for the ship. */
export function buildSpanshPlotterUrl({ source, slef, label }) {
  return `${SPANSH_PLOTTER_URL}#edjt-route=${encodeRequest({ v: 1, source: source?.name ? source : null, slef, label })}`;
}

/**
 * The Fleet Carrier Router link carrying the carrier's system ({ name, id64? }), its type
 * ('fleet' or 'squadron'), its used capacity in tonnes and a label for the carrier.
 */
export function buildSpanshCarrierRouterUrl({ source, carrierType, usedCapacity, label }) {
  const request = { v: 1, source: source?.name ? source : null, carrierType, usedCapacity: Number.isFinite(usedCapacity) ? usedCapacity : null, label };
  return `${SPANSH_CARRIER_ROUTER_URL}#edjt-carrier=${encodeRequest(request)}`;
}

/** The waypoint planner link carrying the start system ({ name }) and a label for the ship. */
export function buildWaypointPlannerUrl({ start, label }) {
  return `${WAYPOINT_PLANNER_URL}#edjt-waypoints=${encodeRequest({ v: 1, start: start?.name ? { name: start.name } : null, label })}`;
}
