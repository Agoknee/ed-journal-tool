/**
 * Small presentational building blocks shared by the dashboard pages.
 */
import CopyableText from './CopyableText.jsx';

/** `id` makes the section a target for the sidebar's sub-section links. */
export function Section({ id, title, actions, children, description }) {
  return (
    <section id={id} className="section">
      <header className="section-header">
        <div>
          <h2>{title}</h2>
          {description && <p className="section-description">{description}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function StatGrid({ children, className = '' }) {
  return <div className={`stat-grid ${className}`.trim()}>{children}</div>;
}

export function StatCard({ label, value, detail, tone, title }) {
  return (
    <div className={`stat-card ${tone ? `stat-card-${tone}` : ''}`} title={title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {detail && <div className="stat-detail">{detail}</div>}
    </div>
  );
}

/**
 * A card for a group of related figures: one headline (with an optional unit after it) and a few
 * smaller label/value lines under it. Lines without a value are left out.
 * rows: [{ label, value, title? }]
 */
export function StatGroupCard({ label, value, unit, rows = [], tone, title }) {
  const shownRows = rows.filter((row) => row && row.value !== null && row.value !== undefined);
  return (
    <div className={`stat-card stat-group-card ${tone ? `stat-card-${tone}` : ''}`} title={title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit"> {unit}</span>}
      </div>
      {shownRows.length > 0 && (
        <dl className="stat-group-rows">
          {shownRows.map((row) => (
            <div key={row.label} className="stat-group-row" title={row.title}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function Tabs({ tabs, activeTab, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeTab}
          className={tab.id === activeTab ? 'tab tab-active' : 'tab'}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Label/value rows. Items with a copyText value can be clicked to copy it to the clipboard. */
export function KeyValueList({ items }) {
  return (
    <dl className="key-value-list">
      {items.filter(Boolean).map(({ label, value, copyText }) => (
        <div key={label} className="key-value-row">
          <dt>{label}</dt>
          <dd>
            {copyText !== undefined && copyText !== null && copyText !== ''
              ? <CopyableText copyText={copyText}>{value ?? '—'}</CopyableText>
              : value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function LoadingState({ requestState, children, emptyMessage = 'No data yet.' }) {
  if (requestState.error) return <div className="notice notice-error">Error: {requestState.error.message}</div>;
  if (!requestState.data) return <div className="notice">Loading…</div>;
  const content = children(requestState.data);
  return content ?? <div className="notice">{emptyMessage}</div>;
}

export function ProgressBar({ value, max, label }) {
  const percentage = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" title={label ?? `${percentage}%`}>
      <div className="progress-fill" style={{ width: `${percentage}%` }} />
    </div>
  );
}
