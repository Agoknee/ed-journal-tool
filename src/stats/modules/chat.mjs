import { Router } from 'express';
import { defineStatModule } from '../define-stat-module.mjs';
import { SqlFilter, addStandardFilters, getOrderByClause, getPagination, runPaginatedQuery } from '../query-helpers.mjs';

/** Sender types: other players, NPCs (ships, stations, crew), system notices, or messages the commander sent. */
const SENDER_TYPES = ['player', 'npc', 'system', 'sent'];

/**
 * Routine game notices that aren't worth keeping:
 * "Entered Channel: <system>" (every jump) and "No fire zone entered/exited." (every station visit).
 */
const SKIPPED_MESSAGE_PREFIXES = ['$COMMS_entered', '$STATION_NoFireZone_'];

/** Unnamed npc-channel messages with these prefixes are game notices; other unnamed ones are NPC chatter. */
const SYSTEM_MESSAGE_PREFIXES = ['$COMMS_', '$STATION_'];

/**
 * Every chat message received (ReceiveText) or sent (SendText).
 */
export default defineStatModule({
  name: 'chat',
  title: 'Chat',
  description: 'Chat messages received and sent, classified as player, NPC, system or sent (routine "Entered Channel" and "No fire zone" notices are skipped).',
  version: 3,
  events: ['ReceiveText', 'SendText'],
  ownedObjects: [{ type: 'table', name: 'chat_messages' }],
  schemaSql: `
    CREATE TABLE IF NOT EXISTS chat_messages (
      id            INTEGER PRIMARY KEY,
      commander_id  INTEGER NOT NULL REFERENCES commanders(id),
      entry_id      INTEGER NOT NULL,
      timestamp     TEXT NOT NULL,
      sender_type   TEXT NOT NULL,    -- player | npc | system | sent
      channel       TEXT,             -- npc, local, starsystem, squadron, wing, player, squadleaders, ...
      sender_name   TEXT,             -- readable sender (NULL for sent messages)
      recipient     TEXT,             -- SendText "To" (channel or player name)
      message       TEXT NOT NULL,    -- localised text when available
      raw_message   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_time ON chat_messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_commander_time ON chat_messages(commander_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_type_time ON chat_messages(sender_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_name);
  `,

  createProcessor(database) {
    const insertMessage = database.prepare(`
      INSERT INTO chat_messages (commander_id, entry_id, timestamp, sender_type, channel, sender_name, recipient, message, raw_message)
      VALUES (:commanderId, :entryId, :timestamp, :senderType, :channel, :senderName, :recipient, :message, :rawMessage)
    `);

    return ({ id: entryId, commanderId, event, timestamp, data }) => {
      const rawMessage = data.Message ?? '';
      if (SKIPPED_MESSAGE_PREFIXES.some((prefix) => rawMessage.startsWith(prefix))) return;
      const message = data.Message_Localised ?? cleanGameToken(rawMessage);

      if (event === 'SendText') {
        insertMessage.run({
          commanderId, entryId, timestamp,
          senderType: 'sent',
          channel: getSentChannel(data.To),
          senderName: null,
          recipient: data.To ?? null,
          message,
          rawMessage,
        });
        return;
      }

      const channel = data.Channel ?? null;
      const senderName = data.From_Localised ?? cleanGameToken(data.From ?? '');
      insertMessage.run({
        commanderId, entryId, timestamp,
        senderType: getSenderType(channel, data.From, rawMessage),
        channel,
        senderName: senderName || null,
        recipient: null,
        message,
        rawMessage,
      });
    };
  },

  createRouter(database) {
    const router = Router();

    const buildMessageFilter = (query, { includeSenderType = true } = {}) => {
      const sqlFilter = addStandardFilters(new SqlFilter(), query, {
        commanderColumn: 'messages.commander_id',
        timestampColumn: 'messages.timestamp',
        searchColumns: ['messages.message', 'messages.sender_name', 'messages.recipient'],
      });

      // senderType accepts a comma-separated list, e.g. "player,sent".
      const senderTypes = String(query.senderType ?? '').split(',').filter((senderType) => SENDER_TYPES.includes(senderType));
      if (includeSenderType && senderTypes.length > 0) {
        sqlFilter.add(`messages.sender_type IN (${senderTypes.map(() => '?').join(', ')})`, ...senderTypes);
      }
      if (query.channel) sqlFilter.add('messages.channel = ?', String(query.channel));
      if (query.sender) sqlFilter.add('messages.sender_name = ?', String(query.sender));
      return sqlFilter;
    };

    // GET /api/stats/chat/messages?commander=&senderType=player,npc,system,sent&channel=&sender=&search=&period=&from=&to=&sort=&order=&limit=&offset=
    router.get('/messages', (request, response) => {
      response.json(runPaginatedQuery(database, {
        selectSql: `
          SELECT messages.id, messages.commander_id, commanders.name AS commander_name, messages.timestamp,
            messages.sender_type, messages.channel, messages.sender_name, messages.recipient, messages.message
          FROM chat_messages AS messages
          JOIN commanders ON commanders.id = messages.commander_id
        `,
        sqlFilter: buildMessageFilter(request.query),
        orderByClause: getOrderByClause(request.query, {
          timestamp: 'messages.timestamp',
          sender: 'messages.sender_name',
          channel: 'messages.channel',
        }, 'timestamp'),
        pagination: getPagination(request.query),
      }));
    });

    // GET /api/stats/chat/totals (same filters, but counts every sender type so the filter chips can show counts)
    router.get('/totals', (request, response) => {
      const sqlFilter = buildMessageFilter(request.query, { includeSenderType: false });
      const fromClause = `FROM chat_messages AS messages ${sqlFilter.whereClause}`;

      response.json({
        bySenderType: database.prepare(`
          SELECT sender_type, COUNT(*) AS message_count ${fromClause} GROUP BY sender_type
        `).all(...sqlFilter.parameters),
        byChannel: database.prepare(`
          SELECT channel, COUNT(*) AS message_count ${fromClause} GROUP BY channel ORDER BY message_count DESC
        `).all(...sqlFilter.parameters),
      });
    });

    return router;
  },
});

/**
 * NPC chatter comes through the "npc" channel. Unnamed messages there are either game notices
 * (e.g. "No fire zone exited.") or unnamed NPCs (e.g. escort wingmen). Everything else is from another player.
 */
function getSenderType(channel, rawSender, rawMessage) {
  if (channel !== 'npc') return rawSender ? 'player' : 'system';
  if (rawSender) return 'npc';
  return SYSTEM_MESSAGE_PREFIXES.some((prefix) => rawMessage.startsWith(prefix)) ? 'system' : 'npc';
}

/** SendText "To" is either a channel name or a player's name (a direct message). */
function getSentChannel(recipient) {
  const knownChannels = new Set(['local', 'wing', 'squadron', 'starsystem', 'squadleaders', 'voicechat', 'friend']);
  return knownChannels.has(recipient) ? recipient : 'player';
}

/**
 * Turns unlocalised game tokens into readable text, e.g.
 *   "$npc_name_decorate:#name=Balveda;"  -> "Balveda"
 *   "$ShipName_Police_Independent;"      -> "ShipName Police Independent"
 */
function cleanGameToken(text) {
  if (!text.startsWith('$')) return text;
  const nameMatch = text.match(/#name=([^;]+);/);
  if (nameMatch) return nameMatch[1];
  return text.replace(/^\$/, '').replace(/;$/, '').replace(/_/g, ' ');
}
