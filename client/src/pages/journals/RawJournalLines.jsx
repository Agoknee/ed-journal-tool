import { useState } from 'react';
import DataTable from '../../components/DataTable.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import { Badge, LoadingState } from '../../components/ui.jsx';
import { formatBytes, formatDateTime, formatNumber } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';
import { useTableState } from '../../hooks/use-list-filters.js';
import './journals.css';

const LINES_PER_PAGE = 50;

/** Pretty-printed JSON when the line is JSON, otherwise the line as it is. */
function formatLineText(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function CommanderBadge({ commander }) {
  return <Badge tone="info" title={commander.fid ? `FID ${commander.fid}` : 'No FID'}>CMDR {commander.name}</Badge>;
}

/**
 * The lines of a journal whose entries aren't stored (flagged, a copy, or waiting for a commander),
 * read from the journal folder when it's opened: what each line is, which commander it names, and
 * why a line can't be read.
 */
export default function RawJournalLines({ journalFile }) {
  const [lineFilter, setLineFilter] = useState('');
  const [search, setSearch] = useState('');
  const [readCount, setReadCount] = useState(0);
  const [expandedLine, setExpandedLine] = useState(null);
  const tableState = useTableState({ tableId: 'journals.raw', defaultSort: 'line', defaultOrder: 'asc', pageSize: LINES_PER_PAGE, resetKey: `${journalFile.id}:${lineFilter}:${search}` });
  const rawRequest = useApi(`/api/journals/${journalFile.id}/raw`, {
    filter: lineFilter,
    search,
    limit: tableState.queryParams.limit,
    offset: tableState.queryParams.offset,
    // Each "Read again" asks the server to read the file afresh.
    read: readCount || undefined,
  }, ['journals']);

  return (
    <LoadingState requestState={rawRequest}>
      {(raw) => (
        <>
          <div className="notice">
            Read from the journal folder {formatDateTime(raw.readAt)}: {formatNumber(raw.lineCount)} lines, {formatBytes(raw.fileSize)}, last changed {formatDateTime(raw.modifiedAt)}.
            {' '}
            {raw.problemCount > 0
              ? <strong>{formatNumber(raw.problemCount)} {raw.problemCount === 1 ? 'line isn’t' : 'lines aren’t'} a readable journal entry.</strong>
              : 'Every line is a readable journal entry.'}
            {raw.endsMidLine && ' The last line has no line ending yet (the game may still be writing it).'}
          </div>
          <div className="raw-commanders">
            <span className="muted">Commanders named in this file:</span>
            {raw.commanders.length === 0 && <span>none yet</span>}
            {raw.commanders.map((commander) => (
              <span key={commander.fid ?? commander.name}>
                <CommanderBadge commander={commander} /> <span className="muted">from line {formatNumber(commander.firstLine)}, {formatNumber(commander.lineCount)} {commander.lineCount === 1 ? 'line' : 'lines'}</span>
              </span>
            ))}
          </div>
          <div className="filter-bar">
            <select value={lineFilter} onChange={(changeEvent) => setLineFilter(changeEvent.target.value)}>
              <option value="">All Lines</option>
              <option value="problems">Unreadable Lines</option>
              <option value="commanders">Lines Naming a Commander</option>
            </select>
            <SearchInput className="filter-search" placeholder="Search line text…" value={search} onChange={(text) => setSearch(text.trim())} />
            <button type="button" onClick={() => setReadCount((count) => count + 1)} disabled={rawRequest.isLoading}>Read Again</button>
          </div>
          <DataTable
            tableId="journals.raw"
            rowKey="line_number"
            isLoading={rawRequest.isLoading}
            rows={raw.rows}
            pagination={{ ...raw, onOffsetChange: tableState.onOffsetChange }}
            emptyMessage={lineFilter || search ? 'No matching lines.' : 'The file is empty.'}
            rowClassName={(line) => (line.problem ? 'row-problem' : '')}
            onRowClick={(line) => setExpandedLine(expandedLine === line.line_number ? null : line.line_number)}
            columns={[
              { key: 'line_number', label: 'Line', align: 'right' },
              { key: 'timestamp', label: 'Time', render: (line) => (line.timestamp ? formatDateTime(line.timestamp) : '—') },
              {
                key: 'event',
                label: 'Event',
                render: (line) => (line.problem
                  ? <Badge tone="danger" title={line.problem}>Unreadable</Badge>
                  : <>{line.event ?? <span className="muted">blank</span>} {line.commander && <CommanderBadge commander={line.commander} />}</>),
              },
              {
                key: 'text',
                label: 'Raw line',
                render: (line) => (expandedLine === line.line_number
                  ? (
                    <>
                      {line.problem && <div className="raw-problem">{line.problem}</div>}
                      <pre className="json-block">{formatLineText(line.text)}</pre>
                    </>
                  )
                  : <span className="truncate raw-line">{line.text}</span>),
              },
            ]}
          />
        </>
      )}
    </LoadingState>
  );
}
