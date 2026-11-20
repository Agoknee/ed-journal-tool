import { useState } from 'react';
import { postJson } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import SearchInput from '../components/SearchInput.jsx';
import { useListFilters, usePagedRows, useTableState } from '../hooks/use-list-filters.js';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTime } from '../format.js';

const JOURNAL_TOPICS = ['journals', 'stats'];
const STATUS_TONES = { ok: 'live', pending: 'warning', corrupt: 'danger' };

const EXAMPLE_QUERIES = [
  { label: 'Events by count', query: 'SELECT event, COUNT(*) AS count\nFROM journal_entries\nGROUP BY event\nORDER BY count DESC\nLIMIT 50;' },
  { label: 'Latest 50 entries', query: 'SELECT id, timestamp, event, data\nFROM journal_entries\nORDER BY id DESC\nLIMIT 50;' },
  { label: 'Bounties by commander', query: "SELECT commanders.name, COUNT(*) AS bounties,\n  SUM(json_extract(data, '$.TotalReward')) AS total_reward\nFROM journal_entries\nJOIN commanders ON commanders.id = journal_entries.commander_id\nWHERE event = 'Bounty'\nGROUP BY commanders.name;" },
  { label: 'Corrupt journal files', query: "SELECT file_name, status_reason, file_size, line_count\nFROM journal_files\nWHERE status = 'corrupt'\nORDER BY sort_key DESC;" },
  { label: 'Known carriers', query: 'SELECT * FROM market_directory\nWHERE is_carrier = 1\nORDER BY last_seen DESC;' },
];

export default function JournalsPage({ commanderFilter }) {
  const [selectedFile, setSelectedFile] = useState(null);
  return (
    <>
      <JournalSummarySection commanderFilter={commanderFilter} />
      <JournalFilesSection commanderFilter={commanderFilter} onSelectFile={setSelectedFile} />
      {selectedFile && <JournalEntriesSection journalFile={selectedFile} onClose={() => setSelectedFile(null)} />}
      <SqlConsoleSection />
      <StatModulesSection />
    </>
  );
}

const EVENTS_PER_PAGE = 10;

function JournalSummarySection({ commanderFilter }) {
  const summaryRequest = useApi('/api/journals/summary', { commander: commanderFilter }, JOURNAL_TOPICS);
  const eventPage = usePagedRows(summaryRequest.data?.topEvents ?? [], { pageSize: EVENTS_PER_PAGE, resetKey: commanderFilter });
  return (
    <LoadingState requestState={summaryRequest}>
      {({ summary, activeFiles }) => (
        <>
          <Section title="Overview">
            <StatGrid>
              <StatCard label="Journal files" value={formatNumber(summary.total_files)} detail={formatBytes(summary.total_bytes)} />
              <StatCard label="Active" value={formatNumber(summary.active_files)} tone={summary.active_files > 0 ? 'live' : undefined} />
              <StatCard label="Parsed" value={formatNumber(summary.ok_files)} />
              <StatCard label="Flagged / corrupt" value={formatNumber(summary.corrupt_files)} tone={summary.corrupt_files > 0 ? 'danger' : undefined} />
              <StatCard label="Pending" value={formatNumber(summary.pending_files)} detail="Waiting for commander info" />
              <StatCard label="Entries" value={formatNumber(summary.total_entries)} detail={summary.skipped_lines ? `${formatNumber(summary.skipped_lines)} unparseable lines skipped` : null} />
              <StatCard label="Date range" value={formatRelativeTime(summary.last_timestamp)} detail={`since ${formatDateTime(summary.first_timestamp)}`} />
            </StatGrid>
          </Section>
          <div className="two-column">
            <Section title="Active journals" description="Journals the game is currently writing to.">
              <DataTable
                rows={activeFiles}
                emptyMessage="No active journals. The game doesn't appear to be running."
                columns={[
                  { key: 'file_name', label: 'File' },
                  { key: 'commander_name', label: 'Commander', render: (file) => file.commander_name ?? <Badge tone="warning">{file.status}</Badge> },
                  { key: 'entry_count', label: 'Entries', align: 'right' },
                  { key: 'last_timestamp', label: 'Last entry', render: (file) => formatRelativeTime(file.last_timestamp) },
                ]}
              />
            </Section>
            <Section title="Most common events">
              <DataTable rowKey="event" rows={eventPage.pageRows} pagination={eventPage.pagination} columns={[
                { key: 'event', label: 'Event' },
                { key: 'entry_count', label: 'Entries', align: 'right' },
              ]} />
            </Section>
          </div>
        </>
      )}
    </LoadingState>
  );
}

function JournalFilesSection({ commanderFilter, onSelectFile }) {
  const { filters, updateFilter, queryParams } = useListFilters();
  const [status, setStatus] = useState('');
  const [isActiveOnly, setIsActiveOnly] = useState(false);
  const filterParams = { commander: commanderFilter, ...queryParams, status, active: isActiveOnly };
  const tableState = useTableState({ defaultSort: 'file', pageSize: 25, resetKey: JSON.stringify(filterParams) });
  const filesRequest = useApi('/api/journals', { ...filterParams, ...tableState.queryParams }, JOURNAL_TOPICS);

  return (
    <Section title="Journal files" description="Click a file to view its entries. Flagged files have no single commander and aren't parsed.">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search file name, commander or reason…">
        <select value={status} onChange={(changeEvent) => setStatus(changeEvent.target.value)}>
          <option value="">All statuses</option>
          <option value="ok">Parsed</option>
          <option value="corrupt">Flagged / corrupt</option>
          <option value="pending">Pending</option>
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={isActiveOnly} onChange={(changeEvent) => setIsActiveOnly(changeEvent.target.checked)} />
          Active only
        </label>
      </FilterBar>
      <DataTable
        isLoading={filesRequest.isLoading}
        rows={filesRequest.data?.rows ?? []}
        sorting={tableState.sorting}
        pagination={filesRequest.data && { ...filesRequest.data, onOffsetChange: tableState.onOffsetChange }}
        onRowClick={onSelectFile}
        columns={[
          { key: 'file_name', label: 'File', sortKey: 'file', render: (file) => <>{file.file_name} {file.is_active === 1 && <Badge tone="live">Active</Badge>}</> },
          { key: 'status', label: 'Status', render: (file) => <Badge tone={STATUS_TONES[file.status]} title={file.status_reason ?? ''}>{file.status === 'ok' ? 'parsed' : file.status}</Badge> },
          { key: 'commander_name', label: 'Commander', render: (file) => file.commander_name ?? <span className="muted">{file.status_reason}</span> },
          { key: 'entry_count', label: 'Entries', align: 'right', sortKey: 'entries' },
          { key: 'file_size', label: 'Size', align: 'right', sortKey: 'size', render: (file) => formatBytes(file.file_size) },
          { key: 'game_version', label: 'Game version', render: (file) => file.game_version ?? '—' },
          { key: 'last_timestamp', label: 'Last entry', sortKey: 'lastTimestamp', render: (file) => formatDateTime(file.last_timestamp) },
        ]}
      />
    </Section>
  );
}

function JournalEntriesSection({ journalFile, onClose }) {
  const [eventFilter, setEventFilter] = useState('');
  const [expandedEntryId, setExpandedEntryId] = useState(null);
  const tableState = useTableState({ defaultSort: 'line', defaultOrder: 'asc', pageSize: 50, resetKey: `${journalFile.id}:${eventFilter}` });
  const entriesRequest = useApi(`/api/journals/${journalFile.id}/entries`, { event: eventFilter, ...tableState.queryParams }, JOURNAL_TOPICS);

  return (
    <Section
      title={journalFile.file_name}
      description={journalFile.status === 'ok' ? `CMDR ${journalFile.commander_name}` : `Not parsed: ${journalFile.status_reason ?? journalFile.status}`}
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      <div className="filter-bar">
        <SearchInput
          className="filter-search"
          placeholder="Filter by exact event name, e.g. FSDJump"
          value={eventFilter}
          onChange={(eventName) => setEventFilter(eventName.trim())}
        />
      </div>
      <DataTable
        isLoading={entriesRequest.isLoading}
        rows={entriesRequest.data?.rows ?? []}
        pagination={entriesRequest.data && { ...entriesRequest.data, onOffsetChange: tableState.onOffsetChange }}
        emptyMessage={journalFile.status === 'ok' ? 'No entries.' : 'Entries from flagged files are not stored.'}
        onRowClick={(entry) => setExpandedEntryId(expandedEntryId === entry.id ? null : entry.id)}
        columns={[
          { key: 'line_number', label: 'Line', align: 'right' },
          { key: 'timestamp', label: 'Time', render: (entry) => formatDateTime(entry.timestamp) },
          { key: 'event', label: 'Event' },
          {
            key: 'data',
            label: 'Data',
            render: (entry) => (expandedEntryId === entry.id
              ? <pre className="json-block">{JSON.stringify(entry.data, null, 2)}</pre>
              : <span className="truncate">{JSON.stringify(entry.data)}</span>),
          },
        ]}
      />
    </Section>
  );
}

function SqlConsoleSection() {
  const [queryText, setQueryText] = useState(EXAMPLE_QUERIES[0].query);
  const [queryResult, setQueryResult] = useState(null);
  const [queryError, setQueryError] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isSchemaVisible, setIsSchemaVisible] = useState(false);
  const schemaRequest = useApi(isSchemaVisible ? '/api/sql/schema' : null, {}, []);

  const runQuery = async () => {
    setIsRunning(true);
    setQueryError(null);
    try {
      setQueryResult(await postJson('/api/sql', { query: queryText }));
    } catch (error) {
      setQueryError(error.message);
      setQueryResult(null);
    } finally {
      setIsRunning(false);
    }
  };

  const handleKeyDown = (keyEvent) => {
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.metaKey)) {
      keyEvent.preventDefault();
      runQuery();
    }
  };

  return (
    <Section
      title="SQL query"
      description="Runs on a read-only connection. Results are limited to 1,000 rows. Use json_extract(data, '$.Field') to read journal fields."
      actions={(
        <>
          <select value="" onChange={(changeEvent) => changeEvent.target.value && setQueryText(changeEvent.target.value)}>
            <option value="">Example queries…</option>
            {EXAMPLE_QUERIES.map((example) => <option key={example.label} value={example.query}>{example.label}</option>)}
          </select>
          <button type="button" onClick={() => setIsSchemaVisible(!isSchemaVisible)}>{isSchemaVisible ? 'Hide' : 'Show'} schema</button>
        </>
      )}
    >
      {isSchemaVisible && (
        <LoadingState requestState={schemaRequest}>
          {({ tables }) => (
            <div className="schema-list">
              {tables.map((table) => (
                <details key={table.name} className="schema-table">
                  <summary>{table.name} <span className="muted small">{table.type}</span></summary>
                  <ul>{table.columns.map((column) => <li key={column.name}>{column.name} <span className="muted">{column.type}</span></li>)}</ul>
                </details>
              ))}
            </div>
          )}
        </LoadingState>
      )}
      <textarea
        className="sql-input"
        spellCheck={false}
        rows={6}
        value={queryText}
        onChange={(changeEvent) => setQueryText(changeEvent.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="sql-actions">
        <button type="button" className="button-primary" onClick={runQuery} disabled={isRunning}>{isRunning ? 'Running…' : 'Run query'}</button>
        <span className="muted small">Ctrl+Enter to run</span>
        {queryResult && (
          <span className="muted small">
            {formatNumber(queryResult.rowCount)} rows{queryResult.isTruncated ? ` (truncated to ${formatNumber(queryResult.maxRows)})` : ''} in {queryResult.elapsedMs} ms
          </span>
        )}
      </div>
      {queryError && <div className="notice notice-error">{queryError}</div>}
      {queryResult && (
        <DataTable
          rowKey="__rowIndex"
          rows={queryResult.rows.map((rowValues, rowIndex) => ({
            __rowIndex: rowIndex,
            ...Object.fromEntries(queryResult.columns.map((columnName, columnIndex) => [columnName, rowValues[columnIndex]])),
          }))}
          columns={queryResult.columns.map((columnName) => ({
            key: columnName,
            label: columnName,
            render: (row) => <span className="truncate" title={String(row[columnName] ?? '')}>{row[columnName] === null ? 'NULL' : String(row[columnName])}</span>,
          }))}
        />
      )}
    </Section>
  );
}

function StatModulesSection() {
  const modulesRequest = useApi('/api/stats', {}, JOURNAL_TOPICS);
  const [rebuildingModule, setRebuildingModule] = useState(null);

  const rebuild = async (moduleName) => {
    setRebuildingModule(moduleName ?? 'all');
    try {
      await postJson('/api/stats/rebuild', moduleName ? { module: moduleName } : {});
    } finally {
      setRebuildingModule(null);
    }
  };

  return (
    <Section
      title="Stat modules"
      description="Each module parses specific journal events into its own tables and only processes new entries."
      actions={<button type="button" disabled={Boolean(rebuildingModule)} onClick={() => rebuild()}>Rebuild all</button>}
    >
      <LoadingState requestState={modulesRequest}>
        {({ modules }) => (
          <DataTable
            rowKey="name"
            rows={modules}
            columns={[
              { key: 'title', label: 'Module', render: (statModule) => <><strong>{statModule.title}</strong><div className="muted small">{statModule.description}</div></> },
              { key: 'events', label: 'Events', render: (statModule) => <span className="muted small">{statModule.events.join(', ')}</span> },
              { key: 'lastEntryId', label: 'Processed to entry', align: 'right' },
              { key: 'updatedAt', label: 'Updated', render: (statModule) => formatRelativeTime(statModule.updatedAt) },
              {
                key: 'rebuild',
                label: '',
                render: (statModule) => (
                  <button type="button" disabled={Boolean(rebuildingModule)} onClick={() => rebuild(statModule.name)}>
                    {rebuildingModule === statModule.name || rebuildingModule === 'all' ? 'Rebuilding…' : 'Rebuild'}
                  </button>
                ),
              },
            ]}
          />
        )}
      </LoadingState>
    </Section>
  );
}
