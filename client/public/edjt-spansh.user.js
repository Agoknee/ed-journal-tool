// ==UserScript==
// @name         ED Journal Tool: Spansh plotter fill-in
// @namespace    ed-journal-tool
// @version      1.3.1
// @description  Fills in the Spansh Galaxy Plotter (source system and ship build), the Spansh Fleet Carrier Router (source system, carrier type and used capacity) and the Wanderer's Toolbox Multi Waypoint Planner (start system, then your pasted list, then Optimize Route) when they're opened from ED Journal Tool.
// @match        https://spansh.co.uk/exact-plotter*
// @match        https://www.spansh.co.uk/exact-plotter*
// @match        https://spansh.co.uk/fleet-carrier*
// @match        https://www.spansh.co.uk/fleet-carrier*
// @match        https://wanderer-toolbox.com/useful-tools/multi-waypoint*
// @match        https://www.wanderer-toolbox.com/useful-tools/multi-waypoint*
// @include      /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//
// @include      /^https?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(:\d+)?\//
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ED Journal Tool opens these pages with what to fill in, in the address's # fragment, which
 * browsers never send to the server. This script reads it, fills in the form and then clears the
 * fragment:
 *
 * - Spansh's Galaxy Plotter (#edjt-route=): the route's starting point and the ship's loadout (SLEF).
 * - Spansh's Fleet Carrier Router (#edjt-carrier=): the carrier's system, whether it's a fleet or
 *   squadron carrier, and its used capacity.
 * - Wanderer's Toolbox Multi Waypoint Planner (#edjt-waypoints=): the start system. It's added and
 *   ticked as the start, then the Add Multiple Systems window opens and waits for a paste: a list of
 *   systems (one per line) is added straight away, leaving out "Primary List" / "Secondary List" /
 *   "Tertiary List" heading lines, and Optimize Route is pressed once they've loaded. Anything else
 *   pastes as usual, to be checked by hand.
 *
 * On the dashboard itself it only marks the page with its version, so the dashboard can tell the
 * script is installed (and new enough for each button). The dashboard may be opened from this
 * computer (localhost) or another on the network (a private LAN address such as 192.168.x.x), so
 * the script is loaded on those addresses, but it only marks a page carrying the dashboard's
 * <meta name="edjt-dashboard"> tag; on any other local page (a router's settings, say) it does
 * nothing.
 */
(() => {
  'use strict';

  const VERSION = '1.3.1';
  const ROUTE_HASH_KEY = 'edjt-route=';
  const CARRIER_HASH_KEY = 'edjt-carrier=';
  const WAYPOINTS_HASH_KEY = 'edjt-waypoints=';
  // Waypoint planner pastes: section headings some lists include, which aren't systems, and what a
  // system name looks like: letters and digits with spaces and - . ' + ( ) * / (e.g.
  // "Col 285 Sector SF-I b25-4", "Sagittarius A*"), up to 64 characters. (Declared up here, before
  // the page-specific code returns early.)
  const LIST_HEADING_PATTERN = /^(primary|secondary|tertiary) list\b/i;
  const SYSTEM_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'+()*/-]{0,63}$/u;

  const isSpansh = /(^|\.)spansh\.co\.uk$/.test(location.hostname);
  const isWandererToolbox = /(^|\.)wanderer-toolbox\.com$/.test(location.hostname);
  if (!isSpansh && !isWandererToolbox) {
    if (document.querySelector('meta[name="edjt-dashboard"]')) document.documentElement.dataset.edjtSpansh = VERSION;
    return;
  }

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  /** The request carried in the # fragment under `key` (then cleared from the address), or null. */
  function readRequest(key) {
    const hashIndex = location.hash.indexOf(key);
    if (hashIndex === -1) return null;
    try {
      const base64 = location.hash.slice(hashIndex + key.length).replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      showNotice('ED Journal Tool: couldn’t read the details in the link.', true);
      console.warn('[ED Journal Tool]', error);
      return null;
    } finally {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  if (isWandererToolbox) {
    const waypointsRequest = readRequest(WAYPOINTS_HASH_KEY);
    if (waypointsRequest) fillWaypoints(waypointsRequest);
    return;
  }

  if (location.pathname.startsWith('/fleet-carrier')) {
    const carrierRequest = readRequest(CARRIER_HASH_KEY);
    if (carrierRequest) fillCarrier(carrierRequest);
    return;
  }

  const request = readRequest(ROUTE_HASH_KEY);
  if (!request) return;

  /** A Spansh page's controller (e.g. "exact-plotter"), reached through the Ember app on the page. */
  function findPlotterController(name = 'exact-plotter') {
    try {
      const metal = window.require?.('@ember/-internals/metal/index');
      for (const namespace of metal?.NAMESPACES ?? []) {
        for (const instance of namespace._applicationInstances ?? []) {
          if (!instance.isDestroyed) return instance.lookup(`controller:${name}`);
        }
      }
    } catch (error) {
      console.warn('[ED Journal Tool]', error);
    }
    return null;
  }

  /** Spansh's record for a system (id64, name and coordinates), found by name. */
  async function findSystem({ name, id64 }) {
    const response = await fetch(`/api/systems/field_values/system_names?${new URLSearchParams({ q: name })}`);
    const systems = (await response.json()).min_max ?? [];
    return systems.find((system) => id64 && String(system.id64) === String(id64))
      ?? systems.find((system) => system.name.toLowerCase() === name.toLowerCase())
      ?? null;
  }

  /** Puts text in a form field the way typing would, so the page notices. */
  function typeInto(field, text) {
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set;
    setValue.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fill() {
    // The app starts after the page loads; wait for the form.
    let controller = null;
    for (let attempt = 0; attempt < 100 && !(controller && document.getElementById('ship_build')); attempt++) {
      await sleep(100);
      controller = findPlotterController();
    }

    const shipBuild = request.slef ? JSON.stringify(request.slef) : null;
    const problems = [];
    if (shipBuild) {
      if (controller) controller.shipBuild = shipBuild;
      else {
        const field = document.getElementById('ship_build');
        if (field) typeInto(field, shipBuild);
        else problems.push('the ship build');
      }
    }

    if (request.source?.name) {
      let system = null;
      try {
        system = await findSystem(request.source);
      } catch (error) {
        console.warn('[ED Journal Tool]', error);
      }
      if (system && controller) controller.source = system;
      else problems.push(system ? 'the source system' : `the source system (Spansh doesn’t know ${request.source.name})`);
    }

    const shipLabel = request.label ? ` for ${request.label}` : '';
    if (problems.length === 0) {
      showNotice(`ED Journal Tool filled in the source system and ship build${shipLabel}. Pick a destination to plot the route.`);
    } else {
      showNotice(`ED Journal Tool couldn’t fill in ${problems.join(' or ')}${shipLabel}. The page may have changed; fill ${problems.length > 1 ? 'them' : 'it'} in by hand.`, true);
    }
  }

  /** The Fleet Carrier Router: the carrier's system, its type (fleet or squadron) and its used capacity. */
  async function fillCarrier(carrierRequest) {
    let controller = null;
    for (let attempt = 0; attempt < 100 && !(controller && document.getElementById('used_capacity')); attempt++) {
      await sleep(100);
      controller = findPlotterController('fleet-carrier');
    }
    const label = carrierRequest.label ? ` for ${carrierRequest.label}` : '';
    if (!controller) {
      showNotice(`ED Journal Tool couldn’t find the router’s form${label}. The page may have changed; fill it in by hand.`, true);
      return;
    }

    const problems = [];
    if (carrierRequest.carrierType === 'fleet' || carrierRequest.carrierType === 'squadron') controller.carrierType = carrierRequest.carrierType;
    if (Number.isFinite(carrierRequest.usedCapacity)) controller.used_capacity = carrierRequest.usedCapacity;
    if (carrierRequest.source?.name) {
      let system = null;
      try {
        system = await findSystem(carrierRequest.source);
      } catch (error) {
        console.warn('[ED Journal Tool]', error);
      }
      if (system) controller.source = system;
      else problems.push(`the source system (Spansh doesn’t know ${carrierRequest.source.name})`);
    }

    const filled = ['the source system', 'carrier type', 'used capacity'].filter((part) => !problems.some((problem) => problem.startsWith(part)));
    const filledText = filled.length > 1 ? `${filled.slice(0, -1).join(', ')} and ${filled.at(-1)}` : filled.join('');
    if (problems.length === 0) {
      showNotice(`ED Journal Tool filled in ${filledText}${label}. Add your destinations to plot the route.`);
    } else {
      showNotice(`ED Journal Tool filled in ${filledText}${label}, but not ${problems.join(' or ')}; fill that in by hand.`, true);
    }
  }

  function showNotice(text, isProblem = false) {
    const notice = document.createElement('div');
    notice.setAttribute('role', 'status');
    notice.textContent = text;
    Object.assign(notice.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647, maxWidth: '420px',
      padding: '10px 14px', borderRadius: '6px', font: '14px/1.4 system-ui, sans-serif', cursor: 'pointer',
      color: '#fff', background: isProblem ? '#9b2c2c' : '#1f5f3f', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
    });
    notice.title = 'Click to close';
    notice.addEventListener('click', () => notice.remove());
    (document.body ?? document.documentElement).append(notice);
    setTimeout(() => notice.remove(), 12000);
  }

  // ----- Wanderer's Toolbox Multi Waypoint Planner -----

  /**
   * The systems in pasted text, one per line, without heading lines, blank lines, repeats or any
   * of `excluded` (case-insensitive); null when it doesn't look like a list of systems.
   */
  function parseSystemList(text, excluded = []) {
    const seen = new Set(excluded.map((name) => name.toLowerCase()));
    const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !LIST_HEADING_PATTERN.test(line));
    if (lines.length === 0 || !lines.every((line) => SYSTEM_NAME_PATTERN.test(line))) return null;
    const systems = [];
    for (const line of lines) {
      if (seen.has(line.toLowerCase())) continue;
      seen.add(line.toLowerCase());
      systems.push(line);
    }
    return systems;
  }

  /** The planner table's system names (the rows after its two heading rows). */
  function plannerSystemRows() {
    const table = document.getElementById('SelectSystemTable');
    return table ? [...table.rows].slice(2) : [];
  }

  /**
   * Presses Optimize Route once the added systems have loaded. Each one is looked up on EDSM, so
   * rows arrive one by one; one EDSM doesn't know never arrives (the page alerts instead), so it
   * goes ahead once no new row has come for a while, and says which were missed.
   */
  async function optimizeWhenLoaded(systems) {
    const WAIT_MS = 60000;
    const QUIET_MS = 5000;
    const hasRow = (name) => plannerSystemRows().some((row) => row.cells[0]?.textContent.trim().toLowerCase() === name.toLowerCase());
    const startedAt = Date.now();
    let rowCount = plannerSystemRows().length;
    let lastChangeAt = Date.now();
    while (Date.now() - startedAt < WAIT_MS) {
      if (systems.every(hasRow)) break;
      await sleep(250);
      const count = plannerSystemRows().length;
      if (count !== rowCount) {
        rowCount = count;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= QUIET_MS) break;
    }
    const missing = systems.filter((name) => !hasRow(name));
    const added = systems.length - missing.length;
    const optimizeButton = document.getElementById('OptimizeRouteButton');
    if (added > 0 && optimizeButton) optimizeButton.click();
    const addedText = `added ${added} system${added === 1 ? '' : 's'}`;
    const missingText = missing.length > 0 ? ` EDSM didn’t find ${missing.join(', ')}, so ${missing.length === 1 ? 'it isn’t' : 'they aren’t'} in the route.` : '';
    if (!optimizeButton) showNotice(`ED Journal Tool ${addedText}, but couldn’t find Optimize Route; press it by hand.${missingText}`, true);
    else showNotice(`ED Journal Tool ${addedText}${added > 0 ? ' and optimized the route' : ''}.${missingText}`, missing.length > 0);
  }

  async function fillWaypoints(request) {
    const startName = request.start?.name ?? null;
    for (let attempt = 0; attempt < 100 && !document.getElementById('OpenMultiAddButton'); attempt++) await sleep(100);
    const nameInput = document.getElementById('SystemNameInput');
    const addButton = document.getElementById('AddButton');
    const openMultiAdd = document.getElementById('OpenMultiAddButton');
    const textArea = document.getElementById('MultiTextArea');
    const multiAddButton = document.getElementById('MultiAddButton');
    if (!nameInput || !addButton || !openMultiAdd || !textArea || !multiAddButton) {
      showNotice('ED Journal Tool couldn’t find the planner’s form. The page may have changed; add the systems by hand.', true);
      return;
    }

    // The start system: added (the page looks it up on EDSM, so the row appears a moment later),
    // then ticked as the start.
    let startProblem = null;
    if (startName) {
      const isStartRow = (row) => row.cells[0]?.textContent.trim().toLowerCase() === startName.toLowerCase();
      let startRow = plannerSystemRows().find(isStartRow);
      if (!startRow) {
        nameInput.value = startName;
        addButton.click();
        nameInput.value = '';
        for (let attempt = 0; attempt < 100 && !startRow; attempt++) {
          await sleep(100);
          startRow = plannerSystemRows().find(isStartRow);
        }
      }
      const startRadio = startRow?.querySelector('input[name="Start-list"]');
      if (startRadio) startRadio.checked = true;
      else startProblem = `couldn’t add ${startName} as the start (EDSM may not know it)`;
    }

    // Then the Add Multiple Systems window, waiting for a paste.
    openMultiAdd.click();
    textArea.focus();
    const shipLabel = request.label ? ` for ${request.label}` : '';
    const startText = startProblem ?? (startName ? `set ${startName} as the start${shipLabel}` : `opened the planner${shipLabel}`);
    showNotice(`ED Journal Tool ${startText}. Paste your list of systems (one per line) to add them.`, Boolean(startProblem));

    const handlePaste = (pasteEvent) => {
      const multiAddWindow = document.getElementById('MultiAddWindow');
      if (multiAddWindow && multiAddWindow.style.display === 'none') return;
      const systems = parseSystemList(pasteEvent.clipboardData?.getData('text/plain'), startName ? [startName] : []);
      if (!systems) {
        showNotice('ED Journal Tool: that doesn’t look like a list of systems (one per line), so it wasn’t added. Check it, then press Add Systems.', true);
        if (pasteEvent.target !== textArea) {
          pasteEvent.preventDefault();
          textArea.value = pasteEvent.clipboardData?.getData('text/plain') ?? '';
          textArea.focus();
        }
        return;
      }
      pasteEvent.preventDefault();
      document.removeEventListener('paste', handlePaste, true);
      if (systems.length === 0) {
        showNotice('ED Journal Tool: every system in that list is already in the route.');
        return;
      }
      textArea.value = systems.join('\n');
      multiAddButton.click();
      optimizeWhenLoaded(systems);
    };
    // Captured on the whole page, so a paste anywhere while the window is open counts.
    document.addEventListener('paste', handlePaste, true);
  }

  fill();
})();
