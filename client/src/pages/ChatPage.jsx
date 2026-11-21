import { useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { Badge, Section } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { formatDateTime, formatNumber } from '../format.js';

const SENDER_TYPE_OPTIONS = [
  { value: 'player', label: 'Players', tone: 'info' },
  { value: 'sent', label: 'Sent', tone: 'live' },
  { value: 'npc', label: 'NPCs', tone: 'neutral' },
  { value: 'system', label: 'System', tone: 'warning' },
];

const SENDER_TYPE_TONES = Object.fromEntries(SENDER_TYPE_OPTIONS.map((option) => [option.value, option.tone]));

/** NPC chatter is hidden until switched on. */
const DEFAULT_SENDER_TYPES = SENDER_TYPE_OPTIONS.map((option) => option.value).filter((senderType) => senderType !== 'npc');

export default function ChatPage({ commanderFilter }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [selectedSenderTypes, setSelectedSenderTypes] = useState(DEFAULT_SENDER_TYPES);
  const [channel, setChannel] = useState('');
  const [sender, setSender] = useState('');

  const baseParams = { commander: commanderFilter, ...queryParams, channel, sender };
  const messageParams = { ...baseParams, senderType: selectedSenderTypes.join(',') };
  const tableState = useTableState({ tableId: 'chat.messages', defaultSort: 'timestamp', resetKey: JSON.stringify(messageParams) });

  const totalsRequest = useApi('/api/stats/chat/totals', baseParams);
  const messagesRequest = useApi(
    selectedSenderTypes.length > 0 ? '/api/stats/chat/messages' : null,
    { ...messageParams, ...tableState.queryParams },
  );

  const countsBySenderType = Object.fromEntries(
    (totalsRequest.data?.bySenderType ?? []).map((row) => [row.sender_type, row.message_count]),
  );

  const toggleSenderType = (senderType) => {
    setSelectedSenderTypes((currentTypes) => (currentTypes.includes(senderType)
      ? currentTypes.filter((currentType) => currentType !== senderType)
      : [...currentTypes, senderType]));
  };

  const messageRows = selectedSenderTypes.length > 0 ? messagesRequest.data?.rows ?? [] : [];

  return (
    <Section title="Messages" description="Click a sender's name to show only their messages.">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search messages or names…">
        <select value={channel} onChange={(changeEvent) => setChannel(changeEvent.target.value)}>
          <option value="">All Channels</option>
          {(totalsRequest.data?.byChannel ?? []).filter((row) => row.channel).map((row) => (
            <option key={row.channel} value={row.channel}>{formatChannel(row.channel)} ({formatNumber(row.message_count)})</option>
          ))}
        </select>
      </FilterBar>

      <div className="toggle-row">
        {SENDER_TYPE_OPTIONS.map((option) => {
          const isSelected = selectedSenderTypes.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className={isSelected ? 'toggle-chip toggle-chip-active' : 'toggle-chip'}
              aria-pressed={isSelected}
              onClick={() => toggleSenderType(option.value)}
            >
              {option.label}
              <span className="toggle-count">{formatNumber(countsBySenderType[option.value] ?? 0)}</span>
            </button>
          );
        })}
        {sender && (
          <span className="active-filter">
            From: <strong>{sender}</strong>
            <button type="button" className="search-clear" onClick={() => setSender('')} aria-label="Clear sender filter" title="Clear">×</button>
          </span>
        )}
      </div>

      <DataTable
        tableId="chat.messages"
        isLoading={messagesRequest.isLoading}
        rows={messageRows}
        sorting={tableState.sorting}
        pagination={selectedSenderTypes.length > 0 && messagesRequest.data && { ...messagesRequest.data, onOffsetChange: tableState.onOffsetChange }}
        emptyMessage={selectedSenderTypes.length > 0 ? 'No messages match these filters.' : 'Select at least one message type.'}
        columns={[
          { key: 'timestamp', label: 'Time', sortKey: 'timestamp', render: (row) => formatDateTime(row.timestamp) },
          ...(commanderFilter === 'all' ? [{ key: 'commander_name', label: 'Commander', render: (row) => `CMDR ${row.commander_name}` }] : []),
          { key: 'channel', label: 'Channel', sortKey: 'channel', render: (row) => <Badge tone={SENDER_TYPE_TONES[row.sender_type]}>{formatChannel(row.channel)}</Badge> },
          { key: 'sender_name', label: 'From', sortKey: 'sender', render: (row) => renderSender(row, setSender) },
          { key: 'message', label: 'Message', wrap: true },
        ]}
      />
    </Section>
  );
}

function renderSender(message, onSelectSender) {
  if (message.sender_type === 'sent') {
    return <span className="muted">You → {message.recipient ?? '—'}</span>;
  }
  if (!message.sender_name) return <span className="muted">—</span>;
  return (
    <button type="button" className="link-button" onClick={() => onSelectSender(message.sender_name)} title="Show only messages from this sender">
      {message.sender_name}
    </button>
  );
}

function formatChannel(channel) {
  const channelLabels = { npc: 'NPC', starsystem: 'System', squadleaders: 'Squad Leaders', player: 'Direct' };
  if (!channel) return '—';
  return channelLabels[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}
