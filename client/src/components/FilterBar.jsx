import SearchInput from './SearchInput.jsx';

const PERIOD_OPTIONS = [
  { value: '', label: 'All Time' },
  { value: '24h', label: 'Last 24 Hours' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
  { value: '1y', label: 'Last Year' },
  { value: 'custom', label: 'Custom Range…' },
];

/**
 * Search box + time period selector. Use with the useListFilters() hook; extra filter
 * controls can be passed as children.
 */
export default function FilterBar({ filters, updateFilter, searchPlaceholder = 'Search…', children }) {
  return (
    <div className="filter-bar">
      <SearchInput
        className="filter-search"
        placeholder={searchPlaceholder}
        value={filters.search}
        onChange={(searchText) => updateFilter('search', searchText)}
      />
      <select value={filters.period} onChange={(changeEvent) => updateFilter('period', changeEvent.target.value)}>
        {PERIOD_OPTIONS.map((periodOption) => (
          <option key={periodOption.value} value={periodOption.value}>{periodOption.label}</option>
        ))}
      </select>
      {filters.period === 'custom' && (
        <>
          <label className="filter-date">
            From <input type="date" value={filters.from} onChange={(changeEvent) => updateFilter('from', changeEvent.target.value)} />
          </label>
          <label className="filter-date">
            To <input type="date" value={filters.to} onChange={(changeEvent) => updateFilter('to', changeEvent.target.value)} />
          </label>
        </>
      )}
      {children}
    </div>
  );
}
