import { useState } from 'react';
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
 * Client-side pagination for a list that's already fully loaded. Returns the current page's rows
 * and DataTable pagination props. Returns to the first page whenever resetKey changes, and stays
 * in range if the list shrinks (e.g. after a live update).
 */
export function usePagedRows(rows, { pageSize = 10, resetKey } = {}) {
  const [pageState, setPageState] = useState({ offset: 0, resetKey });
  if (pageState.resetKey !== resetKey) setPageState({ offset: 0, resetKey });

  const lastPageOffset = Math.max(0, Math.ceil(rows.length / pageSize) - 1) * pageSize;
  const offset = Math.min(pageState.offset, lastPageOffset);

  return {
    pageRows: rows.slice(offset, offset + pageSize),
    pagination: {
      total: rows.length,
      limit: pageSize,
      offset,
      onOffsetChange: (nextOffset) => setPageState((currentState) => ({ ...currentState, offset: nextOffset })),
    },
  };
}

/**
 * Pagination + sorting state for a server-side table. Returns to the first page whenever
 * resetKey (normally the serialized filters) changes.
 */
export function useTableState({ defaultSort, defaultOrder = 'desc', pageSize = 50, resetKey }) {
  const [tableState, setTableState] = useState({ sort: defaultSort, order: defaultOrder, offset: 0, resetKey });
  if (tableState.resetKey !== resetKey) setTableState({ ...tableState, offset: 0, resetKey });

  return {
    queryParams: { sort: tableState.sort, order: tableState.order, limit: pageSize, offset: tableState.offset },
    sorting: {
      sort: tableState.sort,
      order: tableState.order,
      onSortChange: (sortKey) => setTableState((currentState) => ({
        ...currentState,
        sort: sortKey,
        order: currentState.sort === sortKey && currentState.order === 'desc' ? 'asc' : 'desc',
        offset: 0,
      })),
    },
    onOffsetChange: (offset) => setTableState((currentState) => ({ ...currentState, offset })),
  };
}
