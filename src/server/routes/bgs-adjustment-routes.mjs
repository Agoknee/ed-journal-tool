import { Router } from 'express';

/**
 * Manual BGS activity corrections (see bgs_adjustments in the core schema). The user enters the
 * total they want for a field; the server stores the difference from the tracked activity, so the
 * correction keeps meaning the same thing if tracked activity is later rebuilt.
 *
 * GET    /api/bgs-adjustments?commander=<id>
 *        -> { adjustments: [{ id, commanderId, commanderName, tick, systemAddress, starSystem, faction, field, value, updatedAt }] }
 * GET    /api/bgs-adjustments/fields?commander=<id>&tick=<tick>&systemAddress=&starSystem=&faction=
 *        -> { fields: { [field]: { tracked, manual } } } for one commander, tick, system and faction
 * GET    /api/bgs-adjustments/systems?search=<text>
 *        -> { systems: [{ systemAddress, starSystem, factions: [name] }] }, systems the app has seen
 * PUT    /api/bgs-adjustments { commanderId, tick, systemAddress?, starSystem, faction, totals: { [field]: total } }
 *        sets each listed field's total; a total equal to the tracked value removes the adjustment
 * DELETE /api/bgs-adjustments/:id
 *
 * Fields are "<activity_type>" or "<activity_type>:<detail>", matching bgs_activity's rows.
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {import('../../events/event-hub.mjs').EventHub} eventHub
 */

// Allowed fields, and whether their totals may be negative (only influence can be).
const FIELDS = {
  'inf:primary': { allowsNegative: true },
  'inf:secondary': { allowsNegative: true },
  bounty: {},
  combat_bond: {},
  trade_buy: {},
  trade_profit: { allowsNegative: true },
  black_market: { allowsNegative: true },
  exploration: {},
  organic: {},
  murder: {},
  ground_murder: {},
  mission_failed: {},
  scenario: {},
  'space_cz:l': {},
  'space_cz:m': {},
  'space_cz:h': {},
  'space_cz_objective:cs': {},
  'space_cz_objective:so': {},
  'space_cz_objective:cp': {},
  'space_cz_objective:pr': {},
  'ground_cz:l': {},
  'ground_cz:m': {},
  'ground_cz:h': {},
  search_rescue: {},
};
const MAX_NAME_LENGTH = 200;
const MAX_SYSTEM_SUGGESTIONS = 20;

function splitField(field) {
  const [activityType, detail = ''] = field.split(':');
  return { activityType, detail };
}

export function createBgsAdjustmentRoutes(database, eventHub) {
  const router = Router();

  const selectTick = database.prepare('SELECT tick_time FROM bgs_ticks WHERE tick_time = ?');
  const selectNextTick = database.prepare('SELECT tick_time FROM bgs_ticks WHERE tick_time > ? ORDER BY tick_time ASC LIMIT 1');
  const selectCommander = database.prepare('SELECT id FROM commanders WHERE id = ?');
  const selectSystemAddressByName = database.prepare(`
    SELECT system_address FROM bgs_system_states WHERE star_system = ? COLLATE NOCASE ORDER BY timestamp DESC LIMIT 1
  `);
  const selectSystemNameByAddress = database.prepare(`
    SELECT star_system FROM bgs_system_states WHERE system_address = ? ORDER BY timestamp DESC LIMIT 1
  `);
  // A system is matched by address when it has one, otherwise by name.
  const systemCondition = '(CASE WHEN ? IS NOT NULL THEN system_address = ? ELSE system_address IS NULL AND star_system = ? COLLATE NOCASE END)';
  const selectTracked = database.prepare(`
    SELECT activity_type, COALESCE(detail, '') AS detail, SUM(value) AS total
    FROM bgs_activity
    WHERE commander_id = ? AND timestamp >= ? AND (? IS NULL OR timestamp < ?) AND faction = ? AND ${systemCondition}
    GROUP BY activity_type, COALESCE(detail, '')
  `);
  const selectManual = database.prepare(`
    SELECT id, activity_type, detail, value FROM bgs_adjustments
    WHERE commander_id = ? AND timestamp = ? AND faction = ? AND ${systemCondition}
  `);
  const insertAdjustment = database.prepare(`
    INSERT INTO bgs_adjustments (commander_id, timestamp, system_address, star_system, faction, activity_type, detail, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateAdjustment = database.prepare('UPDATE bgs_adjustments SET value = ?, star_system = ?, updated_at = ? WHERE id = ?');
  const deleteAdjustment = database.prepare('DELETE FROM bgs_adjustments WHERE id = ?');

  /** Validates and resolves the commander, tick, system and faction a request is about. */
  function readTarget(source) {
    const commanderId = Number(source.commanderId ?? source.commander);
    if (!Number.isSafeInteger(commanderId) || !selectCommander.get(commanderId)) return { error: 'Unknown commander.' };
    const tick = typeof source.tick === 'string' ? source.tick : '';
    if (!selectTick.get(tick)) return { error: 'Unknown tick.' };
    const faction = typeof source.faction === 'string' ? source.faction.trim() : '';
    if (!faction || faction.length > MAX_NAME_LENGTH) return { error: 'A faction name is required.' };

    let systemAddress = source.systemAddress === undefined || source.systemAddress === null || source.systemAddress === ''
      ? null
      : Number(source.systemAddress);
    if (systemAddress !== null && !Number.isSafeInteger(systemAddress)) return { error: 'Invalid system address.' };
    let starSystem = typeof source.starSystem === 'string' ? source.starSystem.trim() : '';
    if (systemAddress !== null) starSystem = selectSystemNameByAddress.get(systemAddress)?.star_system ?? starSystem;
    if (!starSystem || starSystem.length > MAX_NAME_LENGTH) return { error: 'A system name is required.' };
    // A typed name the app has seen before is stored against that system.
    systemAddress ??= selectSystemAddressByName.get(starSystem)?.system_address ?? null;

    return { commanderId, tick, nextTick: selectNextTick.get(tick)?.tick_time ?? null, faction, systemAddress, starSystem };
  }

  function readFields(target) {
    const systemParameters = [target.systemAddress, target.systemAddress, target.starSystem];
    const fields = Object.fromEntries(Object.keys(FIELDS).map((field) => [field, { tracked: 0, manual: 0, adjustmentId: null }]));
    for (const row of selectTracked.all(target.commanderId, target.tick, target.nextTick, target.nextTick, target.faction, ...systemParameters)) {
      const field = row.detail ? `${row.activity_type}:${row.detail}` : row.activity_type;
      if (fields[field]) fields[field].tracked = row.total;
    }
    for (const row of selectManual.all(target.commanderId, target.tick, target.faction, ...systemParameters)) {
      const field = row.detail ? `${row.activity_type}:${row.detail}` : row.activity_type;
      if (fields[field]) Object.assign(fields[field], { manual: row.value, adjustmentId: row.id });
    }
    return fields;
  }

  router.get('/', (request, response) => {
    const commanderId = request.query.commander && request.query.commander !== 'all' ? Number(request.query.commander) : null;
    const rows = database.prepare(`
      SELECT bgs_adjustments.*, commanders.name AS commander_name
      FROM bgs_adjustments JOIN commanders ON commanders.id = bgs_adjustments.commander_id
      WHERE (? IS NULL OR commander_id = ?)
      ORDER BY timestamp DESC, updated_at DESC
    `).all(commanderId, commanderId);
    response.json({
      adjustments: rows.map((row) => ({
        id: row.id,
        commanderId: row.commander_id,
        commanderName: row.commander_name,
        tick: row.timestamp,
        systemAddress: row.system_address,
        starSystem: row.star_system,
        faction: row.faction,
        field: row.detail ? `${row.activity_type}:${row.detail}` : row.activity_type,
        value: row.value,
        updatedAt: row.updated_at,
      })),
    });
  });

  router.get('/fields', (request, response) => {
    const target = readTarget(request.query);
    if (target.error) return response.status(400).json({ error: target.error });
    const fields = readFields(target);
    response.json({
      fields: Object.fromEntries(Object.entries(fields).map(([field, { tracked, manual }]) => [field, { tracked, manual }])),
    });
  });

  router.get('/systems', (request, response) => {
    const search = typeof request.query.search === 'string' ? request.query.search.trim() : '';
    if (!search) return response.json({ systems: [] });
    // Each matching system's latest known faction list; names starting with the search come first.
    const rows = database.prepare(`
      SELECT system_address, star_system, factions FROM bgs_system_states AS states
      WHERE star_system LIKE ? ESCAPE '\\'
        AND timestamp = (SELECT MAX(timestamp) FROM bgs_system_states WHERE system_address = states.system_address)
      ORDER BY (star_system LIKE ? ESCAPE '\\') DESC, star_system
      LIMIT ?
    `).all(`%${escapeLike(search)}%`, `${escapeLike(search)}%`, MAX_SYSTEM_SUGGESTIONS);
    response.json({
      systems: rows.map((row) => ({
        systemAddress: row.system_address,
        starSystem: row.star_system,
        factions: JSON.parse(row.factions).map((faction) => faction.name),
      })),
    });
  });

  router.put('/', (request, response) => {
    const body = request.body ?? {};
    const target = readTarget(body);
    if (target.error) return response.status(400).json({ error: target.error });
    const totals = body.totals && typeof body.totals === 'object' ? Object.entries(body.totals) : [];
    if (totals.length === 0) return response.status(400).json({ error: 'No totals to save.' });
    for (const [field, total] of totals) {
      if (!FIELDS[field]) return response.status(400).json({ error: `Unknown field "${field}".` });
      if (typeof total !== 'number' || !Number.isFinite(total)) return response.status(400).json({ error: `${field} must be a number.` });
      if (total < 0 && !FIELDS[field].allowsNegative) return response.status(400).json({ error: `${field} can't be negative.` });
    }

    const fields = readFields(target);
    const now = new Date().toISOString();
    database.exec('BEGIN');
    try {
      for (const [field, total] of totals) {
        const { tracked, adjustmentId } = fields[field];
        const value = total - tracked;
        if (value === 0) {
          if (adjustmentId) deleteAdjustment.run(adjustmentId);
        } else if (adjustmentId) {
          updateAdjustment.run(value, target.starSystem, now, adjustmentId);
        } else {
          const { activityType, detail } = splitField(field);
          insertAdjustment.run(target.commanderId, target.tick, target.systemAddress, target.starSystem, target.faction, activityType, detail, value, now, now);
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    eventHub.publish('adjustments', {});
    response.json({ ok: true });
  });

  router.delete('/:id', (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id)) return response.status(400).json({ error: 'Invalid id.' });
    const result = deleteAdjustment.run(id);
    if (result.changes === 0) return response.status(404).json({ error: 'Not found.' });
    eventHub.publish('adjustments', {});
    response.json({ ok: true });
  });

  return router;
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
