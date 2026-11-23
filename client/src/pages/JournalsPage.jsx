import { useEffect, useRef, useState } from 'react';
import { postJson } from '../api.js';
import DataTable from '../components/DataTable.jsx';
import FilterBar from '../components/FilterBar.jsx';
import SearchInput from '../components/SearchInput.jsx';
import { useListFilters, useTableState } from '../hooks/use-list-filters.js';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { useApi } from '../hooks/use-api.js';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTime } from '../format.js';
import RawJournalLines from './journals/RawJournalLines.jsx';

const JOURNAL_TOPICS = ['journals', 'stats'];
const STATUS_TONES = { ok: 'live', pending: 'warning', corrupt: 'danger', duplicate: 'warning' };
const STATUS_LABELS = { ok: 'parsed', duplicate: 'copy' };
const NOT_PARSED_REASONS = { pending: 'waiting for commander info' };

const EXAMPLE_QUERIES = [
  { label: 'Events by Count', query: 'SELECT event, COUNT(*) AS count\nFROM journal_entries\nGROUP BY event\nORDER BY count DESC\nLIMIT 50;' },
  { label: 'Latest 50 Entries', query: 'SELECT id, timestamp, event, data\nFROM journal_entries\nORDER BY id DESC\nLIMIT 50;' },
  { label: 'Bounties by Commander', query: "SELECT commanders.name, COUNT(*) AS bounties,\n  SUM(json_extract(data, '$.TotalReward')) AS total_reward\nFROM journal_entries\nJOIN commanders ON commanders.id = journal_entries.commander_id\nWHERE event = 'Bounty'\nGROUP BY commanders.name;" },
  { label: 'Corrupt Journal Files', query: "SELECT file_name, status_reason, file_size, line_count\nFROM journal_files\nWHERE status = 'corrupt'\nORDER BY sort_key DESC;" },
  { label: 'Known Carriers', query: 'SELECT * FROM market_directory\nWHERE is_carrier = 1\nORDER BY last_seen DESC;' },
];

export default function JournalsPage({ commanderFilter }) {
  const [selection, setSelection] = useState(null);
  const entriesSectionRef = useRef(null);

  // The request counter makes clicking the already-open file scroll to it again.
  const selectFile = (journalFile) => setSelection((previous) => ({ journalFile, requestCount: (previous?.requestCount ?? 0) + 1 }));

  useEffect(() => {
    if (selection) entriesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selection]);

  return (
    <>
      <JournalSummarySection commanderFilter={commanderFilter} onSelectFile={selectFile} />
      <JournalFilesSection commanderFilter={commanderFilter} onSelectFile={selectFile} />
      {selection && (
        <div ref={entriesSectionRef} className="scroll-target">
          <JournalEntriesSection journalFile={selection.journalFile} onClose={() => setSelection(null)} />
        </div>
      )}
      <SqlConsoleSection />
      <StatModulesSection />
    </>
  );
}

const EVENTS_PER_PAGE = 10;

function JournalSummarySection({ commanderFilter, onSelectFile }) {
  const summaryRequest = useApi('/api/journals/summary', { commander: commanderFilter }, JOURNAL_TOPICS);
  return (
    <LoadingState requestState={summaryRequest}>
      {({ summary, activeFiles, topEvents }) => (
        <>
          <Section title="Overview">
            <StatGrid>
              <StatCard label="Journal files" value={formatNumber(summary.total_files)} detail={formatBytes(summary.total_bytes)} />
              <StatCard label="Active" value={formatNumber(summary.active_files)} tone={summary.active_files > 0 ? 'live' : undefined} />
              <StatCard label="Parsed" value={formatNumber(summary.ok_files)} detail={summary.missing_files ? `${formatNumber(summary.missing_files)} no longer in the folder` : null} />
              <StatCard label="Flagged / corrupt" value={formatNumber(summary.corrupt_files)} tone={summary.corrupt_files > 0 ? 'danger' : undefined} />
              <StatCard label="Pending" value={formatNumber(summary.pending_files)} detail="Waiting for commander info" />
              {summary.duplicate_files > 0 && <StatCard label="Copies" value={formatNumber(summary.duplicate_files)} detail="Copies of journals already read; skipped" />}
              <StatCard label="Entries" value={formatNumber(summary.total_entries)} detail={summary.skipped_lines ? `${formatNumber(summary.skipped_lines)} unparseable lines skipped` : null} />
              <StatCard label="Date range" value={formatRelativeTime(summary.last_timestamp)} detail={`since ${formatDateTime(summary.first_timestamp)}`} />
            </StatGrid>
          </Section>
          <div className="two-column">
            <Section title="Active Journals" description="Journals the game is currently writing to. Click one to view its entries.">
              <DataTable
                tableId="journals.active"
                rows={activeFiles}
                onRowClick={onSelectFile}
                emptyMessage="No active journals. The game doesn't appear to be running."
                columns={[
                  { key: 'file_name', label: 'File' },
                  { key: 'commander_name', label: 'Commander', render: (file) => file.commander_name ?? <Badge tone="warning">{file.status}</Badge> },
                  { key: 'entry_count', label: 'Entries', align: 'right' },
                  { key: 'last_timestamp', label: 'Last entry', render: (file) => formatRelativeTime(file.last_timestamp) },
                ]}
              />
            </Section>
            <Section title="Most Common Events">
              <DataTable tableId="journals.events" rowKey="event" rows={topEvents} pageSize={EVENTS_PER_PAGE} pageResetKey={commanderFilter} columns={[
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
  const tableState = useTableState({ tableId: 'journals.files', defaultSort: 'file', pageSize: 25, resetKey: JSON.stringify(filterParams) });
  const filesRequest = useApi('/api/journals', { ...filterParams, ...tableState.queryParams }, JOURNAL_TOPICS);

  return (
    <Section title="Journal Files" description="Click a file to view its entries. Flagged files have no single commander and aren't parsed; copies of journals already read are skipped.">
      <FilterBar filters={filters} updateFilter={updateFilter} searchPlaceholder="Search file name, commander or reason…">
        <select value={status} onChange={(changeEvent) => setStatus(changeEvent.target.value)}>
          <option value="">All Statuses</option>
          <option value="ok">Parsed</option>
          <option value="corrupt">Flagged / Corrupt</option>
          <option value="pending">Pending</option>
          <option value="duplicate">Copies</option>
          <option value="missing">No Longer in Folder</option>
        </select>
        <label className="checkbox">
          <input type="checkbox" checked={isActiveOnly} onChange={(changeEvent) => setIsActiveOnly(changeEvent.target.checked)} />
          Active Only
        </label>
      </FilterBar>
      <DataTable
        tableId="journals.files"
        isLoading={filesRequest.isLoading}
        rows={filesRequest.data?.rows ?? []}
        sorting={tableState.sorting}
        pagination={filesRequest.data && { ...filesRequest.data, onOffsetChange: tableState.onOffsetChange }}
        onRowClick={onSelectFile}
        columns={[
          {
            key: 'file_name',
            label: 'File',
            sortKey: 'file',
            render: (file) => (
              <>
                {file.file_name} {file.is_active === 1 && <Badge tone="live">Active</Badge>}
                {file.is_missing === 1 && <Badge title="No longer in the journal folder; its entries are kept">Removed</Badge>}
              </>
            ),
          },
          { key: 'status', label: 'Status', render: (file) => <Badge tone={STATUS_TONES[file.status]} title={file.status_reason ?? ''}>{STATUS_LABELS[file.status] ?? file.status}</Badge> },
          { key: 'commander_name', label: 'Commander', render: (file) => file.commander_name ?? <span className="muted">{file.status_reason}</span> },
          { key: 'entry_count', label: 'Entries', align: 'right', sortKey: 'entries' },
          { key: 'file_size', label: 'Size', align: 'right', sortKey: 'size', render: (file) => formatBytes(file.file_size) },
          {
            key: 'game_version',
            label: 'Game version',
            render: (file) => (
              <>
                {file.game_version ?? '—'}
                {file.is_legacy === 1 && <> <Badge title="Written by the Legacy game client; left out of all stats">Legacy</Badge></>}
              </>
            ),
          },
          { key: 'last_timestamp', label: 'Last entry', sortKey: 'lastTimestamp', render: (file) => formatDateTime(file.last_timestamp) },
        ]}
      />
    </Section>
  );
}

function JournalEntriesSection({ journalFile, onClose }) {
  const [eventFilter, setEventFilter] = useState('');
  const [expandedEntryId, setExpandedEntryId] = useState(null);
  const tableState = useTableState({ tableId: 'journals.entries', defaultSort: 'line', defaultOrder: 'desc', pageSize: 50, resetKey: `${journalFile.id}:${eventFilter}` });
  const isParsed = journalFile.status === 'ok';
  const entriesRequest = useApi(isParsed ? `/api/journals/${journalFile.id}/entries` : null, { event: eventFilter, ...tableState.queryParams }, JOURNAL_TOPICS);

  if (!isParsed) {
    return (
      <Section
        title={journalFile.file_name}
        description={`Not parsed: ${journalFile.status_reason ?? NOT_PARSED_REASONS[journalFile.status] ?? journalFile.status}. Showing the file as it is in the journal folder.`}
        actions={<button type="button" onClick={onClose}>Close</button>}
      >
        <RawJournalLines key={journalFile.id} journalFile={journalFile} />
      </Section>
    );
  }

  return (
    <Section
      title={journalFile.file_name}
      description={`CMDR ${journalFile.commander_name}`}
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
        tableId="journals.entries"
        isLoading={entriesRequest.isLoading}
        rows={entriesRequest.data?.rows ?? []}
        pagination={entriesRequest.data && { ...entriesRequest.data, onOffsetChange: tableState.onOffsetChange }}
        emptyMessage="No entries."
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
      title="SQL Query"
      description="Runs on a read-only connection. Results are limited to 1,000 rows. Use json_extract(data, '$.Field') to read journal fields."
      actions={(
        <>
          <select value="" onChange={(changeEvent) => changeEvent.target.value && setQueryText(changeEvent.target.value)}>
            <option value="">Example Queries…</option>
            {EXAMPLE_QUERIES.map((example) => <option key={example.label} value={example.query}>{example.label}</option>)}
          </select>
          <button type="button" onClick={() => setIsSchemaVisible(!isSchemaVisible)}>{isSchemaVisible ? 'Hide' : 'Show'} Schema</button>
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
        <button type="button" className="button-primary" onClick={runQuery} disabled={isRunning}>{isRunning ? 'Running…' : 'Run Query'}</button>
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
          tableId="journals.queryResults"
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
      title="Stat Modules"
      description="Each module parses specific journal events into its own tables and only processes new entries."
      actions={<button type="button" disabled={Boolean(rebuildingModule)} onClick={() => rebuild()}>Rebuild All</button>}
    >
      <LoadingState requestState={modulesRequest}>
        {({ modules }) => (
          <DataTable
            tableId="journals.statModules"
            rowKey="name"
            rows={[...modules].sort((first, second) => first.title.localeCompare(second.title))}
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
