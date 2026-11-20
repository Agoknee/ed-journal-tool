/**
 * Table with optional server-side sorting and pagination.
 *
 * columns: [{ key, label, render?(row), sortKey?, align?, wrap? }]  (wrap lets long text wrap instead of widening the table)
 * pagination: { total, limit, offset, onOffsetChange }
 * sorting: { sort, order, onSortChange(sortKey) }
 */
export default function DataTable({ columns, rows, rowKey = 'id', pagination, sorting, onRowClick, emptyMessage = 'No rows.', isLoading }) {
  return (
    <div className={`table-wrapper ${isLoading ? 'is-loading' : ''}`}>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.align === 'right' ? 'align-right' : undefined}>
                  {column.sortKey && sorting ? (
                    <button type="button" className="sort-button" onClick={() => sorting.onSortChange(column.sortKey)}>
                      {column.label}
                      {sorting.sort === column.sortKey && <span className="sort-indicator">{sorting.order === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  ) : column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={columns.length} className="empty-cell">{emptyMessage}</td></tr>
            )}
            {rows.map((row, rowIndex) => (
              <tr
                key={row[rowKey] ?? rowIndex}
                className={onRowClick ? 'clickable-row' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td key={column.key} className={getCellClassName(column)}>
                    {column.render ? column.render(row) : formatCellValue(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pagination && <Pagination {...pagination} />}
    </div>
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
  const classNames = [column.align === 'right' && 'align-right', column.wrap && 'wrap-cell'].filter(Boolean);
  return classNames.length > 0 ? classNames.join(' ') : undefined;
}

function formatCellValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}
