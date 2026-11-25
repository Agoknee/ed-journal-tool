import { useEffect, useState } from 'react';
import { useLiveUpdates } from '../hooks/live-updates-context.js';
import { readTableSettings, SETTINGS_CHANGE_EVENT, updateTableSettings } from '../hooks/table-settings.js';
import TableSettingsDialog from './TableSettingsDialog.jsx';

/**
 * Table with optional sorting and pagination, and a settings gear (columns, order, sort, page size).
 *
 * tableId: names the table for remembering its settings; tables sharing an id share settings
 * columns: [{ key, label, render?(row), sortKey?, sortValue?(row), align?, wrap?, shrink?, className? }]
 *   wrap lets long text wrap instead of widening the table; shrink keeps the column at its content
 *   width instead of sharing the table's spare width. sortKey sorts on the server (with `sorting`);
 *   without `sorting`, rows are sorted here by sortValue(row), or by row[key] when that's a plain value.
 * rowClassName?(row): extra class names for a row
 * Server-side: pagination: { total, limit, offset, onOffsetChange }, sorting from useTableState
 * Client-side: pageSize pages the rows here; pageResetKey returns to the first page when it changes;
 *   defaultSort ({ value: column key, order }) applies until a sort is chosen
 */
export default function DataTable({
  tableId,
  columns,
  rows,
  rowKey = 'id',
  rowClassName,
  pagination,
  sorting,
  pageSize: defaultPageSize,
  pageResetKey,
  defaultSort,
  onRowClick,
  emptyMessage = 'No rows.',
  isLoading,
}) {
  const { isUnreachable } = useLiveUpdates();
  const [settings, setSettings] = useState(() => readTableSettings(tableId));
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [clientPage, setClientPage] = useState({ offset: 0, resetKey: pageResetKey });
  if (clientPage.resetKey !== pageResetKey) setClientPage({ offset: 0, resetKey: pageResetKey });

  useEffect(() => {
    const handleSettingsChange = (changeEvent) => {
      if (changeEvent.detail.tableId === tableId) setSettings(readTableSettings(tableId));
    };
    window.addEventListener(SETTINGS_CHANGE_EVENT, handleSettingsChange);
    return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, handleSettingsChange);
  }, [tableId]);

  const changeSettings = (changes) => {
    setSettings((currentSettings) => ({ ...currentSettings, ...changes }));
    updateTableSettings(tableId, changes);
  };

  // Columns: saved order and visibility applied over the page's definition.
  const hiddenColumnKeys = new Set(settings.hiddenColumns ?? []);
  const orderedColumns = applyColumnOrder(columns, settings.columnOrder);
  let visibleColumns = orderedColumns.filter((column) => !hiddenColumnKeys.has(column.key));
  if (visibleColumns.length === 0) visibleColumns = orderedColumns;

  // Sorting: by the server when the page passes `sorting`, otherwise here.
  const isServerSorted = Boolean(sorting);
  const clientSortableKeys = new Set(isServerSorted ? [] : columns
    .filter((column) => column.sortValue || rows.some((row) => isPlainValue(row[column.key])))
    .map((column) => column.key));
  const getColumnSortKey = (column) => (isServerSorted ? column.sortKey : clientSortableKeys.has(column.key) && column.key);
  const requestedSort = settings.sort ?? defaultSort;
  const clientSort = !isServerSorted && clientSortableKeys.has(requestedSort?.value) ? requestedSort : null;
  const currentSort = isServerSorted ? { value: sorting.sort, order: sorting.order } : clientSort;

  let displayedRows = rows;
  if (clientSort) {
    const sortColumn = columns.find((column) => column.key === clientSort.value);
    displayedRows = sortRows(rows, (row) => (sortColumn.sortValue ? sortColumn.sortValue(row) : row[sortColumn.key]), clientSort.order);
  }

  // Client-side paging, after sorting so pages follow the chosen order.
  const clientPageSize = defaultPageSize ? settings.pageSize ?? defaultPageSize : null;
  let clientPagination = null;
  if (clientPageSize) {
    const lastPageOffset = Math.max(0, Math.ceil(displayedRows.length / clientPageSize) - 1) * clientPageSize;
    const offset = Math.min(clientPage.offset, lastPageOffset);
    clientPagination = {
      total: displayedRows.length,
      limit: clientPageSize,
      offset,
      onOffsetChange: (nextOffset) => setClientPage((currentPage) => ({ ...currentPage, offset: nextOffset })),
    };
    displayedRows = displayedRows.slice(offset, offset + clientPageSize);
  }

  const changeSort = (nextSort) => {
    if (isServerSorted) {
      sorting.onSortSet(nextSort.value, nextSort.order);
      return;
    }
    changeSettings({ sort: nextSort ?? undefined });
    setClientPage((currentPage) => ({ ...currentPage, offset: 0 }));
  };

  const handleHeaderSortClick = (column) => {
    if (isServerSorted) {
      sorting.onSortChange(column.sortKey);
      return;
    }
    if (currentSort?.value === column.key) {
      changeSort({ value: column.key, order: currentSort.order === 'asc' ? 'desc' : 'asc' });
    } else {
      // Text starts A to Z; numbers and dates start with the largest/latest.
      const firstValue = rows.map((row) => (column.sortValue ? column.sortValue(row) : row[column.key])).find(isPlainValue);
      changeSort({ value: column.key, order: typeof firstValue === 'string' && !isTimestamp(firstValue) ? 'asc' : 'desc' });
    }
  };

  const resetSettings = () => {
    changeSettings({ hiddenColumns: undefined, columnOrder: undefined, sort: undefined, pageSize: undefined });
    sorting?.onReset?.();
    setClientPage((currentPage) => ({ ...currentPage, offset: 0 }));
  };

  const moveColumn = (columnKey, direction) => {
    const columnKeys = orderedColumns.map((column) => column.key);
    const fromIndex = columnKeys.indexOf(columnKey);
    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= columnKeys.length) return;
    [columnKeys[fromIndex], columnKeys[toIndex]] = [columnKeys[toIndex], columnKeys[fromIndex]];
    changeSettings({ columnOrder: columnKeys });
  };

  const toggleColumn = (columnKey) => {
    const nextHidden = hiddenColumnKeys.has(columnKey)
      ? [...hiddenColumnKeys].filter((hiddenKey) => hiddenKey !== columnKey)
      : [...hiddenColumnKeys, columnKey];
    changeSettings({ hiddenColumns: nextHidden.length > 0 ? nextHidden : undefined });
  };

  const sortOptions = orderedColumns
    .filter((column) => getColumnSortKey(column))
    .map((column) => ({ value: getColumnSortKey(column), label: getColumnLabel(column) }));
  const activePagination = pagination ?? clientPagination;

  return (
    <div className={`table-wrapper ${isLoading ? 'is-loading' : ''}`}>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const columnSortKey = getColumnSortKey(column);
                // On right-aligned columns the arrow goes first, so the label lines up with the values.
                const isRightAligned = column.align === 'right';
                const sortIndicator = currentSort?.value === columnSortKey && (
                  <span className={isRightAligned ? 'sort-indicator sort-indicator-leading' : 'sort-indicator'}>{currentSort.order === 'asc' ? '▲' : '▼'}</span>
                );
                return (
                  <th key={column.key} className={getCellClassName(column)}>
                    {columnSortKey ? (
                      <button type="button" className="sort-button" onClick={() => handleHeaderSortClick(column)}>
                        {isRightAligned && sortIndicator}
                        {column.label}
                        {!isRightAligned && sortIndicator}
                      </button>
                    ) : column.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayedRows.length === 0 && (
              <tr>
                <td colSpan={visibleColumns.length} className="empty-cell">
                  {/* An empty table while EDJT can't be reached most likely just hasn't loaded ("No missions yet" would mislead). */}
                  {isUnreachable ? 'Not loaded yet. It loads once EDJT is back.' : emptyMessage}
                </td>
              </tr>
            )}
            {displayedRows.map((row, rowIndex) => (
              <tr
                key={row[rowKey] ?? rowIndex}
                className={[onRowClick && 'clickable-row', rowClassName?.(row)].filter(Boolean).join(' ') || undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {visibleColumns.map((column) => (
                  <td key={column.key} className={getCellClassName(column)}>
                    {column.render ? column.render(row) : formatCellValue(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Sits over the end of the header row rather than in a column of its own, so it doesn't change column widths. */}
      <button type="button" className="table-settings-button" aria-label="Table settings" title="Table settings" onClick={() => setIsSettingsOpen(true)}>
        <GearIcon />
      </button>
      {activePagination && <Pagination {...activePagination} />}

      <TableSettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        columns={orderedColumns.map((column) => ({
          key: column.key,
          label: getColumnLabel(column),
          isVisible: visibleColumns.includes(column),
        }))}
        onToggleColumn={toggleColumn}
        onMoveColumn={moveColumn}
        sortOptions={sortOptions}
        sort={currentSort}
        allowDefaultSort={!isServerSorted}
        onSortChange={changeSort}
        pageSize={isServerSorted ? sorting.pageSize ?? null : clientPageSize}
        onPageSizeChange={(nextPageSize) => {
          if (isServerSorted) {
            sorting.onPageSizeChange(nextPageSize);
            return;
          }
          changeSettings({ pageSize: nextPageSize });
          setClientPage((currentPage) => ({ ...currentPage, offset: 0 }));
        }}
        onReset={resetSettings}
      />
    </div>
  );
}

/**
 * Puts the columns in the saved order. Columns the saved order doesn't know about (added since)
 * keep their place after the column that precedes them in the page's definition.
 */
function applyColumnOrder(columns, columnOrder) {
  if (!columnOrder?.length) return columns;
  const columnsByKey = new Map(columns.map((column) => [column.key, column]));
  const orderedColumns = columnOrder.filter((columnKey) => columnsByKey.has(columnKey)).map((columnKey) => columnsByKey.get(columnKey));
  columns.forEach((column, index) => {
    if (orderedColumns.includes(column)) return;
    const previousColumn = columns[index - 1];
    const insertAt = previousColumn ? orderedColumns.indexOf(previousColumn) + 1 : 0;
    orderedColumns.splice(insertAt, 0, column);
  });
  return orderedColumns;
}

/** Sorts a copy of the rows; empty values always go last. Text compares naturally ("N2" before "N10"). */
function sortRows(rows, getValue, order) {
  const direction = order === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: getValue(row) }))
    .sort((first, second) => {
      const isFirstEmpty = first.value === null || first.value === undefined || first.value === '';
      const isSecondEmpty = second.value === null || second.value === undefined || second.value === '';
      if (isFirstEmpty || isSecondEmpty) return isFirstEmpty - isSecondEmpty || first.index - second.index;
      const comparison = typeof first.value === 'string' || typeof second.value === 'string'
        ? String(first.value).localeCompare(String(second.value), undefined, { numeric: true, sensitivity: 'base' })
        : Number(first.value) - Number(second.value);
      return comparison * direction || first.index - second.index;
    })
    .map(({ row }) => row);
}

function isPlainValue(value) {
  return value !== null && value !== undefined && value !== '' && ['string', 'number', 'boolean'].includes(typeof value);
}

function isTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value);
}

function getColumnLabel(column) {
  return typeof column.label === 'string' && column.label ? column.label : column.key;
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function Pagination({ total, limit, offset, onOffsetChange }) {
  if (!total) return null;
  const pageNumber = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span>{Number(total).toLocaleString()} rows</span>
      <div className="pagination-buttons">
        <button type="button" disabled={offset === 0} onClick={() => onOffsetChange(0)}>«</button>
        <button type="button" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - limit))}>‹</button>
        <span>Page {pageNumber} of {pageCount}</span>
        <button type="button" disabled={pageNumber >= pageCount} onClick={() => onOffsetChange(offset + limit)}>›</button>
        <button type="button" disabled={pageNumber >= pageCount} onClick={() => onOffsetChange((pageCount - 1) * limit)}>»</button>
      </div>
    </div>
  );
}

function getCellClassName(column) {
  const classNames = [column.align === 'right' && 'align-right', column.wrap && 'wrap-cell', column.shrink && 'shrink-cell', column.className].filter(Boolean);
  return classNames.length > 0 ? classNames.join(' ') : undefined;
}

function formatCellValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}
