import { useEffect, useRef } from 'react';
import { PAGE_SIZE_OPTIONS } from '../hooks/table-settings.js';

/**
 * Modal for configuring one table: which columns show and in what order, how it's sorted, and
 * how many rows each page holds. Changes apply immediately; there's nothing to confirm.
 *
 * columns: every column in display order, each { key, label, isVisible }
 * sortOptions: [{ value, label }] for the sortable columns
 * sort: { value, order } or null for the table's default order (only allowed when allowDefaultSort)
 * pageSize: current rows per page, or null when the table isn't paginated
 */
export default function TableSettingsDialog({
  isOpen,
  onClose,
  columns,
  onToggleColumn,
  onMoveColumn,
  sortOptions,
  sort,
  allowDefaultSort,
  onSortChange,
  pageSize,
  onPageSizeChange,
  onReset,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  const visibleColumnCount = columns.filter((column) => column.isVisible).length;

  return (
    <dialog
      ref={dialogRef}
      className="table-settings-dialog"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(clickEvent) => clickEvent.target === dialogRef.current && onClose()}
    >
      <div className="table-settings-body">
        <header className="table-settings-header">
          <h2>Table Settings</h2>
          <button type="button" className="table-settings-close" aria-label="Close" onClick={onClose}>✕</button>
        </header>

        <h3 className="subheading">Columns</h3>
        <ul className="table-settings-columns">
          {columns.map((column, index) => (
            <li key={column.key}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={column.isVisible}
                  // At least one column has to stay visible.
                  disabled={column.isVisible && visibleColumnCount === 1}
                  onChange={() => onToggleColumn(column.key)}
                />
                <span className={column.isVisible ? undefined : 'muted'}>{column.label}</span>
              </label>
              <span className="table-settings-move">
                <button type="button" aria-label={`Move ${column.label} up`} disabled={index === 0} onClick={() => onMoveColumn(column.key, -1)}>▲</button>
                <button type="button" aria-label={`Move ${column.label} down`} disabled={index === columns.length - 1} onClick={() => onMoveColumn(column.key, 1)}>▼</button>
              </span>
            </li>
          ))}
        </ul>

        {sortOptions.length > 0 && (
          <>
            <h3 className="subheading">Sort</h3>
            <div className="table-settings-row">
              <select
                aria-label="Sort by"
                value={sort?.value ?? ''}
                onChange={(changeEvent) => onSortChange(changeEvent.target.value
                  ? { value: changeEvent.target.value, order: sort?.order ?? 'desc' }
                  : null)}
              >
                {allowDefaultSort && <option value="">Default Order</option>}
                {sortOptions.map((sortOption) => <option key={sortOption.value} value={sortOption.value}>{sortOption.label}</option>)}
              </select>
              <select
                aria-label="Sort direction"
                value={sort?.order ?? 'desc'}
                disabled={!sort}
                onChange={(changeEvent) => onSortChange({ value: sort.value, order: changeEvent.target.value })}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </>
        )}

        {pageSize != null && (
          <>
            <h3 className="subheading">Rows Per Page</h3>
            <select aria-label="Rows per page" value={pageSize} onChange={(changeEvent) => onPageSizeChange(Number(changeEvent.target.value))}>
              {[...new Set([...PAGE_SIZE_OPTIONS, pageSize])].sort((first, second) => first - second)
                .map((sizeOption) => <option key={sizeOption} value={sizeOption}>{sizeOption}</option>)}
            </select>
          </>
        )}

        <footer className="table-settings-footer">
          <button type="button" onClick={onReset}>Reset to Defaults</button>
          <button type="button" className="button-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </dialog>
  );
}
