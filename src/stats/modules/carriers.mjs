import { Router } from 'express';
import { runInTransaction } from '../../database/database.mjs';
import { getCommodityDisplayName } from '../commodity-names.mjs';
import { defineStatModule } from '../define-stat-module.mjs';
import {
  SqlFilter, addStandardFilters, getCommanderIdFilter, getOrderByClause, getPagination, parseJsonColumns, runPaginatedQuery,
} from '../query-helpers.mjs';

const CARRIER_RELATIONSHIPS = { FleetCarrier: 'owner', SquadronCarrier: 'squadron' };
const CARRIER_TYPE_LABELS = { FleetCarrier: 'FC', SquadronCarrier: 'SFC' };

/** Events that end a commander's squadron membership (and so their squadron carrier link). */
const SQUADRON_CHANGE_EVENTS = new Set(['JoinedSquadron', 'LeftSquadron', 'KickedFromSquadron', 'DisbandedSquadron']);
const CURRENT_SQUADRON_STATE_KEY = 'currentSquadron';

/** Journals don't log cooldowns: a jump starts a 4:50 cooldown when it departs, a cancelled jump 1 minute. */
const JUMP_COOLDOWN_MS = (4 * 60 + 50) * 1000;
const CANCELLED_JUMP_COOLDOWN_MS = 60 * 1000;

function addMilliseconds(timestamp, milliseconds) {
  return timestamp ? new Date(Date.parse(timestamp) + milliseconds).toISOString().replace('.000Z', 'Z') : null;
}

/**
 * Events that name a body along with its system address and body id. CarrierLocation only reports a
 * body id, so these let the carrier's body be shown by name.
 */
const BODY_NAME_EVENTS = [
  'Scan', 'FSSBodySignals', 'SAASignalsFound', 'Location', 'FSDJump', 'SupercruiseExit', 'ApproachBody',
  'Touchdown', 'Liftoff', 'Embark', 'Disembark', 'CarrierJump', 'CarrierJumpRequest',
];

/**
 * Fleet carriers (FC) and squadron fleet carriers (SFC) the commanders manage:
 * location, jumps, balances, services, trade orders and capacity.
 *
 * A commander can only be in one squadron, so only their current squadron's carrier is linked;
 * the link is dropped when they join, leave or are removed from a squadron.
 *
 * A fleet carrier is always owned by the commander managing it. A squadron carrier is only
 * considered owned when the commander's journals contain its CarrierBuy; otherwise it's a squadron link.
 */
export default defineStatModule({
  name: 'carriers',
  title: 'Carriers',
  description: 'Fleet carrier and squadron carrier details: location, jumps, finances, crew services and trade orders.',
  version: 8,
  dependsOn: ['markets', 'commanders'],
  events: [
    'CarrierStats', 'CarrierBuy', 'CarrierLocation', 'CarrierJumpRequest', 'CarrierJumpCancelled', 'CarrierJump',
    'CarrierFinance', 'CarrierBankTransfer', 'CarrierCrewServices', 'CarrierDepositFuel', 'CarrierNameChange',
    'CarrierDockingPermission', 'CarrierTradeOrder', 'CarrierDecommission', 'CarrierCancelDecommission',
    'SquadronStartup', ...SQUADRON_CHANGE_EVENTS, ...BODY_NAME_EVENTS,
  ],
  ownedObjects: [
    { type: 'table', name: 'carriers' },
    { type: 'table', name: 'carrier_commanders' },
    { type: 'table', name: 'carrier_jump_history' },
    { type: 'table', name: 'carrier_transactions' },
    { type: 'table', name: 'carrier_body_names' },
  ],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS carriers (
      carrier_id            INTEGER PRIMARY KEY,   -- the carrier's market id
      carrier_type          TEXT,                  -- FleetCarrier | SquadronCarrier
      callsign              TEXT,
      name                  TEXT,
      docking_access        TEXT,
      allow_notorious       INTEGER,
      fuel_level            INTEGER,
      jump_range_current    REAL,
      jump_range_max        REAL,
      space_usage           TEXT,
      finance               TEXT NOT NULL DEFAULT '{}',
      crew_services         TEXT NOT NULL DEFAULT '{}',
      ship_packs            TEXT,
      module_packs          TEXT,
      trade_orders          TEXT NOT NULL DEFAULT '{}',
      star_system           TEXT,
      system_address        INTEGER,
      body                  TEXT,
      body_id               INTEGER,
      location_updated_at   TEXT,
      pending_jump          TEXT,
      pending_decommission  INTEGER NOT NULL DEFAULT 0,
      decommission_time     TEXT,
      bought_at             TEXT,
      purchase_price        INTEGER,
      stats_updated_at      TEXT,
      cooldown_starts_at    TEXT,                  -- when the last requested jump departs/departed, or when it was cancelled
      cooldown_ends_at      TEXT,
      first_seen_at         TEXT,
      updated_at            TEXT
    );

    CREATE TABLE IF NOT EXISTS carrier_commanders (
      carrier_id     INTEGER NOT NULL,
      commander_id   INTEGER NOT NULL REFERENCES commanders(id),
      relationship   TEXT NOT NULL,   -- owner | squadron
      last_seen      TEXT,
      PRIMARY KEY (carrier_id, commander_id)
    );

    CREATE TABLE IF NOT EXISTS carrier_jump_history (
      id              INTEGER PRIMARY KEY,
      carrier_id      INTEGER NOT NULL,
      commander_id    INTEGER NOT NULL,
      timestamp       TEXT NOT NULL,
      jump_event      TEXT NOT NULL,   -- requested | cancelled | arrived
      star_system     TEXT,
      body            TEXT,
      departure_time  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_carrier_jump_history_carrier ON carrier_jump_history(carrier_id, timestamp);

    CREATE TABLE IF NOT EXISTS carrier_transactions (
      id                INTEGER PRIMARY KEY,
      carrier_id        INTEGER NOT NULL,
      commander_id      INTEGER NOT NULL,
      timestamp         TEXT NOT NULL,
      transaction_type  TEXT NOT NULL,   -- deposit | withdraw
      amount            INTEGER NOT NULL,
      carrier_balance   INTEGER,
      player_balance    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_carrier_transactions_carrier ON carrier_transactions(carrier_id, timestamp);

    CREATE TABLE IF NOT EXISTS carrier_body_names (
      system_address  INTEGER NOT NULL,
      body_id         INTEGER NOT NULL,
      body_name       TEXT NOT NULL,
      PRIMARY KEY (system_address, body_id)
    );
  `,

  createProcessor(database) {
    const selectCarrier = database.prepare('SELECT * FROM carriers WHERE carrier_id = ?');
    const upsertBodyName = database.prepare(`
      INSERT INTO carrier_body_names (system_address, body_id, body_name) VALUES (?, ?, ?)
      ON CONFLICT (system_address, body_id) DO UPDATE SET body_name = excluded.body_name
    `);
    const insertCarrier = database.prepare('INSERT OR IGNORE INTO carriers (carrier_id, carrier_type, first_seen_at, updated_at) VALUES (?, ?, ?, ?)');
    const upsertCarrierCommander = database.prepare(`
      INSERT INTO carrier_commanders (carrier_id, commander_id, relationship, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT (carrier_id, commander_id) DO UPDATE SET last_seen = excluded.last_seen,
        relationship = CASE WHEN carrier_commanders.relationship = 'owner' THEN 'owner' ELSE excluded.relationship END
    `);
    const deleteOtherSquadronLinks = database.prepare(`
      DELETE FROM carrier_commanders WHERE commander_id = ? AND relationship = 'squadron' AND carrier_id != ?
    `);
    const insertJumpHistory = database.prepare(`
      INSERT INTO carrier_jump_history (carrier_id, commander_id, timestamp, jump_event, star_system, body, departure_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTransaction = database.prepare(`
      INSERT INTO carrier_transactions (carrier_id, commander_id, timestamp, transaction_type, amount, carrier_balance, player_balance)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    /** Updates the given columns of a carrier row. Column names come from this module only. */
    const updateStatementsBySql = new Map();
    const updateCarrier = (carrierId, timestamp, columnValues) => {
      const columnNames = Object.keys(columnValues);
      const setClause = [...columnNames.map((columnName) => `${columnName} = ?`), 'updated_at = ?'].join(', ');
      const updateSql = `UPDATE carriers SET ${setClause} WHERE carrier_id = ?`;
      if (!updateStatementsBySql.has(updateSql)) updateStatementsBySql.set(updateSql, database.prepare(updateSql));
      updateStatementsBySql.get(updateSql).run(...columnNames.map((columnName) => columnValues[columnName]), timestamp, carrierId);
    };

    /** Creates the carrier (if needed) and links the commander to it. Returns the carrier row. */
    const ensureCarrier = (carrierId, carrierType, commanderId, timestamp) => {
      const knownCarrierType = CARRIER_RELATIONSHIPS[carrierType] ? carrierType : null;
      insertCarrier.run(carrierId, knownCarrierType, timestamp, timestamp);
      const carrierRow = selectCarrier.get(carrierId);
      const effectiveCarrierType = knownCarrierType ?? carrierRow.carrier_type;
      if (knownCarrierType && !carrierRow.carrier_type) updateCarrier(carrierId, timestamp, { carrier_type: knownCarrierType });
      if (effectiveCarrierType) {
        const relationship = CARRIER_RELATIONSHIPS[effectiveCarrierType];
        // Only one squadron at a time, so a squadron carrier replaces any previous one.
        if (relationship === 'squadron') deleteOtherSquadronLinks.run(commanderId, carrierId);
        upsertCarrierCommander.run(carrierId, commanderId, relationship, timestamp);
      }
      return carrierRow;
    };

    /** Drops the commander's squadron carrier link when their squadron membership changes. */
    const handleSquadronEvent = (commanderId, event, data, moduleState) => {
      const squadronName = event === 'SquadronStartup' || event === 'JoinedSquadron' ? data.SquadronName ?? null : null;
      const previousSquadronName = moduleState.get(CURRENT_SQUADRON_STATE_KEY) ?? null;
      const hasChangedSquadron = SQUADRON_CHANGE_EVENTS.has(event) || squadronName !== previousSquadronName;
      if (hasChangedSquadron) deleteOtherSquadronLinks.run(commanderId, -1);
      moduleState.set(CURRENT_SQUADRON_STATE_KEY, squadronName);
    };

    const updateJsonColumn = (carrierRow, columnName, timestamp, updateFunction) => {
      const currentValue = JSON.parse(carrierRow[columnName] ?? '{}');
      updateCarrier(carrierRow.carrier_id, timestamp, { [columnName]: JSON.stringify(updateFunction(currentValue)) });
    };

    const setLocation = (carrierRow, timestamp, location) => {
      // A location reported before a requested jump departs doesn't cancel that jump.
      const pendingJump = carrierRow.pending_jump ? JSON.parse(carrierRow.pending_jump) : null;
      const isJumpStillPending = Boolean(pendingJump?.departureTime && timestamp < pendingJump.departureTime);
      updateCarrier(carrierRow.carrier_id, timestamp, {
        star_system: location.starSystem ?? null,
        system_address: location.systemAddress ?? null,
        body: location.body ?? null,
        body_id: location.bodyId ?? null,
        location_updated_at: timestamp,
        pending_jump: isJumpStillPending ? carrierRow.pending_jump : null,
      });
    };

    return ({ commanderId, event, timestamp, data }, moduleState) => {
      const bodyName = data.BodyName ?? data.Body;
      if (Number.isInteger(data.SystemAddress) && Number.isInteger(data.BodyID) && typeof bodyName === 'string' && bodyName) {
        upsertBodyName.run(data.SystemAddress, data.BodyID, bodyName);
      }
      if (event !== 'CarrierJump' && event !== 'CarrierJumpRequest' && BODY_NAME_EVENTS.includes(event)) return;

      if (event === 'SquadronStartup' || SQUADRON_CHANGE_EVENTS.has(event)) {
        handleSquadronEvent(commanderId, event, data, moduleState);
        return;
      }

      // CarrierJump and CarrierDepositFuel can involve anyone's carrier; only track known ones.
      if (event === 'CarrierJump' || event === 'CarrierDepositFuel') {
        const carrierId = event === 'CarrierJump' ? data.MarketID : data.CarrierID;
        const carrierRow = carrierId ? selectCarrier.get(carrierId) : null;
        if (!carrierRow) return;

        if (event === 'CarrierJump') {
          setLocation(carrierRow, timestamp, { starSystem: data.StarSystem, systemAddress: data.SystemAddress, body: data.Body, bodyId: data.BodyID });
          insertJumpHistory.run(carrierRow.carrier_id, commanderId, timestamp, 'arrived', data.StarSystem ?? null, data.Body ?? null, null);
        } else {
          updateCarrier(carrierRow.carrier_id, timestamp, { fuel_level: data.Total ?? carrierRow.fuel_level });
        }
        return;
      }

      const carrierId = data.CarrierID;
      if (!carrierId) return;
      const carrierRow = ensureCarrier(carrierId, data.CarrierType, commanderId, timestamp);

      switch (event) {
        case 'CarrierStats':
          updateCarrier(carrierId, timestamp, {
            callsign: data.Callsign ?? carrierRow.callsign,
            name: data.Name ?? carrierRow.name,
            docking_access: data.DockingAccess ?? null,
            allow_notorious: data.AllowNotorious === undefined ? null : Number(data.AllowNotorious),
            fuel_level: data.FuelLevel ?? null,
            jump_range_current: data.JumpRangeCurr ?? null,
            jump_range_max: data.JumpRangeMax ?? null,
            pending_decommission: Number(Boolean(data.PendingDecommission)),
            space_usage: JSON.stringify(data.SpaceUsage ?? null),
            finance: JSON.stringify(normalizeFinance(data.Finance ?? {})),
            crew_services: JSON.stringify(Object.fromEntries((data.Crew ?? []).map((crewMember) => [crewMember.CrewRole, {
              activated: Boolean(crewMember.Activated),
              enabled: Boolean(crewMember.Enabled),
              crewName: crewMember.CrewName ?? null,
            }]))),
            ship_packs: JSON.stringify(data.ShipPacks ?? []),
            module_packs: JSON.stringify(data.ModulePacks ?? []),
            stats_updated_at: timestamp,
          });
          break;

        case 'CarrierBuy':
          // Buying a carrier makes the commander its owner, including squadron carriers.
          upsertCarrierCommander.run(carrierId, commanderId, 'owner', timestamp);
          updateCarrier(carrierId, timestamp, {
            callsign: data.Callsign ?? null,
            bought_at: timestamp,
            purchase_price: data.Price ?? null,
            star_system: data.Location ?? null,
            system_address: data.SystemAddress ?? null,
            location_updated_at: timestamp,
          });
          break;

        case 'CarrierNameChange':
          updateCarrier(carrierId, timestamp, { name: data.Name ?? carrierRow.name, callsign: data.Callsign ?? carrierRow.callsign });
          break;

        case 'CarrierLocation':
          setLocation(carrierRow, timestamp, { starSystem: data.StarSystem, systemAddress: data.SystemAddress, bodyId: data.BodyID });
          break;

        case 'CarrierJumpRequest': {
          const pendingJump = {
            starSystem: data.SystemName ?? null,
            systemAddress: data.SystemAddress ?? null,
            body: data.Body ?? null,
            bodyId: data.BodyID ?? null,
            departureTime: data.DepartureTime ?? null,
            requestedAt: timestamp,
          };
          updateCarrier(carrierId, timestamp, {
            pending_jump: JSON.stringify(pendingJump),
            cooldown_starts_at: pendingJump.departureTime,
            cooldown_ends_at: addMilliseconds(pendingJump.departureTime, JUMP_COOLDOWN_MS),
          });
          insertJumpHistory.run(carrierId, commanderId, timestamp, 'requested', pendingJump.starSystem, pendingJump.body, pendingJump.departureTime);
          break;
        }

        case 'CarrierJumpCancelled':
          updateCarrier(carrierId, timestamp, {
            pending_jump: null,
            cooldown_starts_at: timestamp,
            cooldown_ends_at: addMilliseconds(timestamp, CANCELLED_JUMP_COOLDOWN_MS),
          });
          insertJumpHistory.run(carrierId, commanderId, timestamp, 'cancelled', null, null, null);
          break;

        case 'CarrierFinance':
          updateJsonColumn(carrierRow, 'finance', timestamp, (finance) => ({ ...finance, ...normalizeFinance(data) }));
          break;

        case 'CarrierBankTransfer': {
          const transactionType = data.Deposit !== undefined ? 'deposit' : 'withdraw';
          const amount = data.Deposit ?? data.Withdraw ?? 0;
          insertTransaction.run(carrierId, commanderId, timestamp, transactionType, amount, data.CarrierBalance ?? null, data.PlayerBalance ?? null);
          updateJsonColumn(carrierRow, 'finance', timestamp, (finance) => ({ ...finance, carrierBalance: data.CarrierBalance ?? finance.carrierBalance }));
          break;
        }

        case 'CarrierCrewServices':
          updateJsonColumn(carrierRow, 'crew_services', timestamp, (crewServices) => ({
            ...crewServices,
            [data.CrewRole]: applyCrewOperation(crewServices[data.CrewRole] ?? {}, data),
          }));
          break;

        case 'CarrierDockingPermission':
          updateCarrier(carrierId, timestamp, {
            docking_access: data.DockingAccess ?? carrierRow.docking_access,
            allow_notorious: data.AllowNotorious === undefined ? carrierRow.allow_notorious : Number(data.AllowNotorious),
          });
          break;

        case 'CarrierTradeOrder':
          updateJsonColumn(carrierRow, 'trade_orders', timestamp, (tradeOrders) => {
            const commodityKey = data.Commodity;
            if (data.CancelTrade) {
              const { [commodityKey]: cancelledOrder, ...remainingOrders } = tradeOrders;
              return remainingOrders;
            }
            return {
              ...tradeOrders,
              [commodityKey]: {
                commodity: getCommodityDisplayName(data.Commodity_Localised, data.Commodity),
                orderType: data.PurchaseOrder !== undefined ? 'buy' : 'sell',
                quantity: data.PurchaseOrder ?? data.SaleOrder ?? 0,
                price: data.Price ?? null,
                isBlackMarket: Boolean(data.BlackMarket),
                updatedAt: timestamp,
              },
            };
          });
          break;

        case 'CarrierDecommission':
          updateCarrier(carrierId, timestamp, {
            pending_decommission: 1,
            decommission_time: data.ScrapTime ? new Date(data.ScrapTime * 1000).toISOString() : null,
          });
          break;

        case 'CarrierCancelDecommission':
          updateCarrier(carrierId, timestamp, { pending_decommission: 0, decommission_time: null });
          break;
      }
    };
  },

  createRouter(database) {
    const router = Router();

    const loadCarriers = (commanderIdFilter) => {
      // Only carriers a commander currently owns or belongs to. Names/callsigns fall back to the
      // market directory, since squadron members may never see the carrier's management stats.
      const carrierRows = database.prepare(`
        SELECT carriers.*,
          COALESCE(carriers.name, directory.carrier_name) AS name,
          COALESCE(carriers.callsign, directory.callsign) AS callsign,
          body_names.body_name AS looked_up_body_name,
          carrier_notes.note
        FROM carriers
        LEFT JOIN market_directory AS directory ON directory.market_id = carriers.carrier_id
        LEFT JOIN carrier_notes ON carrier_notes.carrier_id = carriers.carrier_id
        LEFT JOIN carrier_body_names AS body_names
          ON body_names.system_address = carriers.system_address AND body_names.body_id = carriers.body_id
        WHERE carriers.carrier_id IN (SELECT carrier_id FROM carrier_commanders WHERE ?1 IS NULL OR commander_id = ?1)
        ORDER BY carriers.carrier_type, name
      `).all(commanderIdFilter);
      const commanderLinks = database.prepare(`
        SELECT links.carrier_id, links.commander_id, links.relationship, links.last_seen, commanders.name AS commander_name
        FROM carrier_commanders AS links JOIN commanders ON commanders.id = links.commander_id
      `).all();
      const selectBodyName = database.prepare('SELECT body_name FROM carrier_body_names WHERE system_address = ? AND body_id = ?');
      // CarrierLocation and some jump requests only give a body id; look up its name from other events.
      const withBodyName = (location) => (location && !location.body && location.systemAddress != null && location.bodyId != null
        ? { ...location, body: selectBodyName.get(location.systemAddress, location.bodyId)?.body_name ?? null }
        : location);

      return parseJsonColumns(carrierRows, ['space_usage', 'finance', 'crew_services', 'ship_packs', 'module_packs', 'trade_orders', 'pending_jump'])
        .map(({ looked_up_body_name: lookedUpBodyName, ...carrierRow }) => ({
          ...carrierRow,
          body: carrierRow.body ?? lookedUpBodyName ?? null,
          pending_jump: withBodyName(carrierRow.pending_jump),
        }))
        .map((carrier) => ({
          ...carrier,
          carrier_type_label: CARRIER_TYPE_LABELS[carrier.carrier_type] ?? carrier.carrier_type,
          commanders: commanderLinks.filter((link) => link.carrier_id === carrier.carrier_id),
          acquired_at: carrier.bought_at ?? carrier.first_seen_at,
          effective_location: getEffectiveLocation(carrier),
          is_decommissioned: Boolean(carrier.pending_decommission && carrier.decommission_time && Date.parse(carrier.decommission_time) < Date.now()),
        }));
    };

    // GET /api/stats/carriers?commander= -> carriers plus each commander's squadron, owned carriers and status (None/FC/SFC/FC + SFC)
    const selectCarrierNote = database.prepare('SELECT note FROM carrier_notes WHERE carrier_id = ?');
    const selectCommanderNote = database.prepare('SELECT note FROM commander_notes WHERE commander_id = ?');
    const upsertCarrierNote = database.prepare(`
      INSERT INTO carrier_notes (carrier_id, note, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (carrier_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
    `);
    const upsertCommanderNote = database.prepare(`
      INSERT INTO commander_notes (commander_id, note, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (commander_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
    `);
    const deleteCarrierNote = database.prepare('DELETE FROM carrier_notes WHERE carrier_id = ?');
    const deleteCommanderNote = database.prepare('DELETE FROM commander_notes WHERE commander_id = ?');

    /**
     * Keeps notes on the rows the overview shows: a commander's note moves to their (oldest) carrier
     * once they own one, and a decommissioned carrier's note moves back to its owner. A note moved
     * onto one that already exists is appended to it. Returns true if anything moved.
     */
    const moveNotesToVisibleRows = (carriers, commanderStatuses) => runInTransaction(database, () => {
      const now = new Date().toISOString();
      let hasMovedNotes = false;
      for (const status of commanderStatuses) {
        const ownedCarrierIds = new Set([...status.fleetCarrierIds, ...status.squadronCarrierIds]);
        const ownedCarriers = carriers
          .filter((carrier) => ownedCarrierIds.has(carrier.carrier_id))
          .sort((first, second) => (first.acquired_at ?? '￿').localeCompare(second.acquired_at ?? '￿'));
        const lostCarriers = carriers.filter((carrier) => carrier.is_decommissioned && carrier.note
          && carrier.commanders.some((link) => link.commander_id === status.commanderId && link.relationship === 'owner'));

        let commanderNote = selectCommanderNote.get(status.commanderId)?.note ?? null;
        for (const lostCarrier of lostCarriers) {
          commanderNote = joinNotes(commanderNote, lostCarrier.note);
          deleteCarrierNote.run(lostCarrier.carrier_id);
          hasMovedNotes = true;
        }

        if (commanderNote && ownedCarriers.length > 0) {
          const targetCarrierId = ownedCarriers[0].carrier_id;
          upsertCarrierNote.run(targetCarrierId, joinNotes(selectCarrierNote.get(targetCarrierId)?.note, commanderNote), now);
          deleteCommanderNote.run(status.commanderId);
          hasMovedNotes = true;
        } else if (lostCarriers.length > 0) {
          upsertCommanderNote.run(status.commanderId, commanderNote, now);
        }
      }
      return hasMovedNotes;
    });

    const loadOverview = (commanderIdFilter) => {
      const carriers = loadCarriers(commanderIdFilter);

      const commanderRows = database.prepare(`
        SELECT commanders.id, commanders.name, profiles.squadron_name, commander_notes.note
        FROM commanders
        LEFT JOIN commander_profiles AS profiles ON profiles.commander_id = commanders.id
        LEFT JOIN commander_notes ON commander_notes.commander_id = commanders.id
        WHERE ?1 IS NULL OR commanders.id = ?1 ORDER BY commanders.name
      `).all(commanderIdFilter);
      const commanderStatuses = commanderRows.map((commander) => {
        const ownedCarriers = carriers.filter((carrier) => !carrier.is_decommissioned
          && carrier.commanders.some((link) => link.commander_id === commander.id && link.relationship === 'owner'));
        const getCarrierIds = (carrierType) => ownedCarriers
          .filter((carrier) => carrier.carrier_type === carrierType)
          .map((carrier) => carrier.carrier_id);
        const fleetCarrierIds = getCarrierIds('FleetCarrier');
        const squadronCarrierIds = getCarrierIds('SquadronCarrier');
        const carrierStatus = [fleetCarrierIds.length > 0 && 'FC', squadronCarrierIds.length > 0 && 'SFC'].filter(Boolean).join(' + ') || 'None';
        // Journals don't log the commander's own squadron ID, but a squadron carrier's callsign is its squadron's ID.
        const squadronCarrier = commander.squadron_name ? carriers.find((carrier) => carrier.carrier_type === 'SquadronCarrier'
          && !carrier.is_decommissioned
          && carrier.commanders.some((link) => link.commander_id === commander.id)) : null;
        return {
          commanderId: commander.id,
          commanderName: commander.name,
          squadronName: commander.squadron_name,
          commanderNote: commander.note,
          squadronId: squadronCarrier?.callsign ?? null,
          carrierStatus,
          fleetCarrierIds,
          squadronCarrierIds,
        };
      });
      return { carriers, commanderStatuses };
    };

    router.get('/', (request, response) => {
      const commanderIdFilter = getCommanderIdFilter(request.query);
      let overview = loadOverview(commanderIdFilter);
      if (moveNotesToVisibleRows(overview.carriers, overview.commanderStatuses)) overview = loadOverview(commanderIdFilter);
      response.json(overview);
    });

    // GET /api/stats/carriers/jumps?carrier=&commander=&period=&search=&limit=&offset=
    router.get('/jumps', (request, response) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
        timestampColumn: 'history.timestamp',
        searchColumns: ['history.star_system', 'carriers.name', 'carriers.callsign', 'directory.carrier_name', 'directory.callsign'],
      });
      if (request.query.carrier) sqlFilter.add('history.carrier_id = ?', Number(request.query.carrier));
      const commanderIdFilter = getCommanderIdFilter(request.query);
      if (commanderIdFilter !== null) {
        sqlFilter.add('history.carrier_id IN (SELECT carrier_id FROM carrier_commanders WHERE commander_id = ?)', commanderIdFilter);
      }

      response.json(runPaginatedQuery(database, {
        selectSql: `
          SELECT history.*, COALESCE(carriers.name, directory.carrier_name) AS carrier_name, COALESCE(carriers.callsign, directory.callsign) AS callsign, commanders.name AS commander_name
          FROM carrier_jump_history AS history
          LEFT JOIN carriers ON carriers.carrier_id = history.carrier_id
          LEFT JOIN market_directory AS directory ON directory.market_id = history.carrier_id
          LEFT JOIN commanders ON commanders.id = history.commander_id
        `,
        sqlFilter,
        orderByClause: getOrderByClause(request.query, { timestamp: 'history.timestamp' }, 'timestamp'),
        pagination: getPagination(request.query),
      }));
    });

    // GET /api/stats/carriers/transactions?carrier=&commander=&period=&limit=&offset=
    router.get('/transactions', (request, response) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), request.query, {
        commanderColumn: 'transactions.commander_id',
        timestampColumn: 'transactions.timestamp',
      });
      if (request.query.carrier) sqlFilter.add('transactions.carrier_id = ?', Number(request.query.carrier));

      response.json(runPaginatedQuery(database, {
        selectSql: `
          SELECT transactions.*, COALESCE(carriers.name, directory.carrier_name) AS carrier_name, COALESCE(carriers.callsign, directory.callsign) AS callsign, commanders.name AS commander_name
          FROM carrier_transactions AS transactions
          LEFT JOIN carriers ON carriers.carrier_id = transactions.carrier_id
          LEFT JOIN market_directory AS directory ON directory.market_id = transactions.carrier_id
          LEFT JOIN commanders ON commanders.id = transactions.commander_id
        `,
        sqlFilter,
        orderByClause: getOrderByClause(request.query, { timestamp: 'transactions.timestamp', amount: 'transactions.amount' }, 'timestamp'),
        pagination: getPagination(request.query),
      }));
    });

    return router;
  },
});

function joinNotes(existingNote, addedNote) {
  if (!existingNote || existingNote === addedNote) return addedNote;
  return `${existingNote} · ${addedNote}`;
}

function normalizeFinance(financeData) {
  const taxRates = Object.fromEntries(
    Object.entries(financeData)
      .filter(([key]) => key.startsWith('TaxRate_'))
      .map(([key, value]) => [key.replace('TaxRate_', ''), value]),
  );
  const normalizedFinance = {
    carrierBalance: financeData.CarrierBalance,
    reserveBalance: financeData.ReserveBalance,
    availableBalance: financeData.AvailableBalance,
    reservePercent: financeData.ReservePercent,
    ...(financeData.TaxRate !== undefined && { taxRate: financeData.TaxRate }),
    ...(Object.keys(taxRates).length > 0 && { taxRates }),
  };
  return Object.fromEntries(Object.entries(normalizedFinance).filter(([, value]) => value !== undefined));
}

function applyCrewOperation(crewService, { Operation: operation, CrewName: crewName }) {
  switch (operation) {
    case 'Activate': return { ...crewService, activated: true, enabled: true, crewName: crewName ?? crewService.crewName };
    case 'Deactivate': return { ...crewService, activated: false, enabled: false };
    case 'Pause': return { ...crewService, enabled: false };
    case 'Resume': return { ...crewService, enabled: true };
    case 'Replace': return { ...crewService, crewName: crewName ?? crewService.crewName };
    default: return crewService;
  }
}

/** If a requested jump's departure time has passed, the carrier is most likely at the destination. */
function getEffectiveLocation(carrier) {
  const pendingJump = carrier.pending_jump;
  const hasDeparted = pendingJump?.departureTime && Date.parse(pendingJump.departureTime) <= Date.now();
  if (hasDeparted) {
    return { starSystem: pendingJump.starSystem, body: pendingJump.body, isAssumed: true, since: pendingJump.departureTime };
  }
  return { starSystem: carrier.star_system, body: carrier.body, isAssumed: false, since: carrier.location_updated_at };
}
