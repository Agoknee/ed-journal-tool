import { useState } from 'react';
import { readTableSettings, updateTableSettings } from './table-settings.js';
import { useDebouncedValue } from './use-api.js';

/**
 * State for the common search/time-period filters. Returns the filter state, a setter and
 * the API query parameters (with the search text debounced).
 */
export function useListFilters(initialFilters = {}) {
  const [filters, setFilters] = useState({ search: '', period: '', from: '', to: '', ...initialFilters });
  const debouncedSearch = useDebouncedValue(filters.search);

  const updateFilter = (filterName, filterValue) => {
    setFilters((currentFilters) => ({ ...currentFilters, [filterName]: filterValue }));
  };

  const isCustomPeriod = filters.period === 'custom';
  const queryParams = {
    search: debouncedSearch,
    period: isCustomPeriod ? '' : filters.period,
    from: isCustomPeriod ? filters.from : '',
    to: isCustomPeriod ? filters.to : '',
  };

  return { filters, updateFilter, queryParams };
}

/**
 * Pagination + sorting state for a server-side table. Returns to the first page whenever
 * resetKey (normally the serialized filters) changes. With a tableId, the sort and page size the
 * user picks (by clicking headers or in the table's settings) are remembered; pass the same
 * tableId to the DataTable.
 */
export function useTableState({ tableId, defaultSort, defaultOrder = 'desc', pageSize: defaultPageSize = 50, resetKey }) {
  const [tableState, setTableState] = useState(() => {
    const { sort: storedSort, pageSize: storedPageSize } = readTableSettings(tableId);
    return {
      sort: storedSort?.value ?? defaultSort,
      order: storedSort?.order ?? defaultOrder,
      pageSize: storedPageSize ?? defaultPageSize,
      offset: 0,
      resetKey,
    };
  });
  if (tableState.resetKey !== resetKey) setTableState({ ...tableState, offset: 0, resetKey });

  const setSort = (sort, order) => {
    setTableState((currentState) => ({ ...currentState, sort, order, offset: 0 }));
    updateTableSettings(tableId, { sort: { value: sort, order } });
  };

  return {
    queryParams: { sort: tableState.sort, order: tableState.order, limit: tableState.pageSize, offset: tableState.offset },
    sorting: {
      sort: tableState.sort,
      order: tableState.order,
      // Header click: a new column sorts descending; the same column flips direction.
      onSortChange: (sortKey) => setSort(sortKey, tableState.sort === sortKey && tableState.order === 'desc' ? 'asc' : 'desc'),
      onSortSet: setSort,
      pageSize: tableState.pageSize,
      onPageSizeChange: (pageSize) => {
        setTableState((currentState) => ({ ...currentState, pageSize, offset: 0 }));
        updateTableSettings(tableId, { pageSize });
      },
      /** Back to the default sort and page size, forgetting the saved ones. */
      onReset: () => {
        setTableState((currentState) => ({ ...currentState, sort: defaultSort, order: defaultOrder, pageSize: defaultPageSize, offset: 0 }));
        updateTableSettings(tableId, { sort: undefined, pageSize: undefined });
      },
    },
    onOffsetChange: (offset) => setTableState((currentState) => ({ ...currentState, offset })),
  };
}
