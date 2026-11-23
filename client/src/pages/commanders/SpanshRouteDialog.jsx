import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../clipboard.js';
import { formatNumber, formatSystemName } from '../../format.js';
import { buildSpanshCarrierRouterUrl, buildSpanshPlotterUrl, buildWaypointPlannerUrl, SPANSH_USERSCRIPT_PATH } from '../../spansh.js';

/**
 * Shown when a route button is used but the userscript wasn't found on this page (or is too old
 * to fill in that page): how to set it up, and a way to open the page anyway with what it needs on
 * the clipboard.
 *
 * request: { label, source, getExport } for the Spansh plotter, { kind: 'waypoints', label, source,
 * isOutdated } for the waypoint planner, or { kind: 'carrier', label, source, carrierType,
 * usedCapacity, isOutdated } for the Spansh Fleet Carrier Router; null when closed
 */
export default function SpanshRouteDialog({ request, onClose }) {
  const dialogRef = useRef(null);
  const [exported, setExported] = useState({ request: null, slef: null, failed: false });
  const [copied, setCopied] = useState({ request: null, status: null });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (request && !dialog.open) dialog.showModal();
    if (!request && dialog.open) dialog.close();
  }, [request]);

  // The build is fetched as soon as the dialog opens, so the button can copy it straight away
  // (browsers only allow copying during the click itself).
  useEffect(() => {
    if (!request?.getExport) return undefined;
    let isCurrent = true;
    request.getExport().then(
      (result) => isCurrent && setExported({ request, slef: result.slef, failed: false }),
      () => isCurrent && setExported({ request, slef: null, failed: true }),
    );
    return () => { isCurrent = false; };
  }, [request]);

  // Results for an earlier ship are ignored until this one's arrive.
  const isExportCurrent = exported.request === request;
  const slef = isExportCurrent ? exported.slef : null;
  const exportFailed = isExportCurrent && exported.failed;
  const copyStatus = copied.request === request ? copied.status : null;
  const isWaypoints = request?.kind === 'waypoints';
  const isCarrier = request?.kind === 'carrier';
  const openAnyway = async () => {
    if (isCarrier) {
      const isCopied = request.source?.name ? await copyToClipboard(request.source.name) : false;
      setCopied({ request, status: isCopied ? 'copied' : null });
      window.open(buildSpanshCarrierRouterUrl(request), '_blank', 'noopener');
      return;
    }
    if (isWaypoints) {
      const isCopied = request.source?.name ? await copyToClipboard(request.source.name) : false;
      setCopied({ request, status: isCopied ? 'copied' : null });
      window.open(buildWaypointPlannerUrl({ start: request.source, label: request.label }), '_blank', 'noopener');
      return;
    }
    const isCopied = await copyToClipboard(JSON.stringify(slef));
    setCopied({ request, status: isCopied ? 'copied' : 'failed' });
    window.open(buildSpanshPlotterUrl({ source: request.source, slef, label: request.label }), '_blank', 'noopener');
  };

  const sourceName = formatSystemName(request?.source?.name);
  return (
    <dialog
      ref={dialogRef}
      className="table-settings-dialog spansh-dialog"
      onClose={onClose}
      onClick={(clickEvent) => clickEvent.target === dialogRef.current && onClose()}
    >
      {request && (
        <div className="table-settings-body">
          <header className="table-settings-header">
            <h2>{isCarrier ? 'Plot a Carrier Route on Spansh' : isWaypoints ? 'Plan a Multi-Waypoint Route' : 'Plot a Route on Spansh'}</h2>
            <button type="button" className="table-settings-close" aria-label="Close" onClick={onClose}>✕</button>
          </header>
          {isCarrier ? (
            <p className="muted small">
              Spansh’s Fleet Carrier Router can’t be filled in from a link on its own. A small userscript fixes that: it
              fills in the carrier’s system, whether it’s a fleet or squadron carrier, and its used capacity from the link the
              dashboard opens, and does nothing else.
            </p>
          ) : isWaypoints ? (
            <p className="muted small">
              The Wanderer’s Toolbox Multi Waypoint Planner can’t be filled in from a link on its own. A small userscript
              fixes that: it adds the ship’s system as the start, opens Add Multiple Systems, and adds the list of systems
              you paste (one per line). It does nothing else.
            </p>
          ) : (
            <p className="muted small">
              Spansh’s Galaxy Plotter can’t be filled in from a link on its own. A small userscript fixes that: it reads the
              ship’s build and starting system from the link the dashboard opens, fills in the form, and does nothing else.
            </p>
          )}

          {request.isOutdated && (
            <p className="small spansh-problem">
              The userscript installed in this browser is an older version that doesn’t fill in {isCarrier ? 'the Fleet Carrier Router' : 'the waypoint planner'}.
              Install it again from step 2 below to update it, then reload this page.
            </p>
          )}

          <h3 className="subheading">Set up auto-fill (once)</h3>
          <ol className="spansh-steps">
            <li>
              Install a userscript extension in this browser, such as{' '}
              <a href="https://violentmonkey.github.io/get-it/" target="_blank" rel="noreferrer">Violentmonkey</a> or{' '}
              <a href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">Tampermonkey</a>.
              Chrome and Edge also need the extension’s “Allow user scripts” setting (or developer mode) turned on.
            </li>
            <li>
              <a href={SPANSH_USERSCRIPT_PATH} target="_blank" rel="noreferrer">Install the ED Journal Tool userscript</a>.
              The extension opens it and asks you to confirm.
            </li>
            <li>Reload this page. The route buttons then go straight to Spansh or the waypoint planner with everything filled in.</li>
          </ol>
          <p className="muted small">
            The dashboard spots the script when it’s opened on this computer (localhost) or by its LAN address
            (e.g. 192.168.x.x). On another address, such as a computer name, auto-fill still
            works, but this window shows each time; use the button below.
          </p>

          <h3 className="subheading">Or open it now</h3>
          {isCarrier ? (
            <>
              <p className="muted small">
                Opens the router and copies the carrier’s system{sourceName ? <> (<strong>{sourceName}</strong>)</> : null} to the
                clipboard. Without the userscript, paste it as the Source System, choose{' '}
                {request.carrierType === 'squadron' ? 'Squadron Carrier' : 'Player Carrier'}
                {Number.isFinite(request.usedCapacity) ? <> and enter <strong>{formatNumber(request.usedCapacity)}</strong> as Used Capacity</> : null}.
              </p>
              <div className="table-settings-footer">
                <span className="small muted">{copyStatus === 'copied' ? 'System copied.' : ''}</span>
                <button type="button" onClick={openAnyway}>Open the router and copy the system</button>
              </div>
            </>
          ) : isWaypoints ? (
            <>
              <p className="muted small">
                Opens the planner and copies the start system{sourceName ? <> (<strong>{sourceName}</strong>)</> : null} to the
                clipboard. Without the userscript, paste it into System name, press Add System and tick it as Start System,
                then use Add Multiple Systems for your list.
              </p>
              <div className="table-settings-footer">
                <span className="small muted">{copyStatus === 'copied' ? 'Start system copied.' : ''}</span>
                <button type="button" onClick={openAnyway}>Open the planner and copy the start</button>
              </div>
            </>
          ) : (
            <>
              <p className="muted small">
                Opens the plotter{sourceName ? <> (start: <strong>{sourceName}</strong>)</> : null} and copies {request.label}’s
                build to the clipboard. Without the userscript, paste the build into Ship Build and type in the source system.
              </p>
              <div className="table-settings-footer">
                <span className={`small ${copyStatus === 'failed' || exportFailed ? 'spansh-problem' : 'muted'}`}>
                  {exportFailed ? 'Couldn’t load this ship’s build.' : copyStatus === 'copied' ? 'Build copied.' : copyStatus === 'failed' ? 'Copy failed.' : ''}
                </span>
                <button type="button" onClick={openAnyway} disabled={!slef}>
                  {slef || exportFailed ? 'Open Spansh and copy build' : 'Loading build…'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
