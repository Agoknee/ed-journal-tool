/**
 * Small presentational building blocks shared by the dashboard pages.
 */
import { useLiveUpdates } from '../hooks/live-updates-context.js';
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

/**
 * A request's data, or what to show instead. Data already loaded is still shown when a refresh
 * fails: while EDJT can't be reached the connection banner at the top says so, so nothing is shown
 * here; another failure gets a note above it. Without data, it's "Loading…", a short note when
 * EDJT can't be reached (it loads by itself once it's back), or the error.
 *
 * "Can't be reached" is either this request failing that way, or the live updates being down: a
 * request waiting on another's answer (a commander's details on the commander list) never starts
 * then, so it would otherwise say "Loading…" for as long as EDJT is away.
 */
export function LoadingState({ requestState, children, emptyMessage = 'No data yet.' }) {
  const { data, error } = requestState;
  const { isUnreachable } = useLiveUpdates();
  if (data) {
    const content = children(data) ?? <div className="notice">{emptyMessage}</div>;
    if (!error || error.isUnreachable) return content;
    return (
      <>
        <div className="notice notice-warning">Couldn’t refresh this: {error.message} It shows what was loaded before.</div>
        {content}
      </>
    );
  }
  if (error?.isUnreachable || (!error && isUnreachable)) return <div className="notice">Not loaded yet. It loads once EDJT is back.</div>;
  if (error) return <div className="notice notice-error">Couldn’t load this: {error.message}</div>;
  return <div className="notice">Loading…</div>;
}

export function ProgressBar({ value, max, label }) {
  const percentage = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" title={label ?? `${percentage}%`}>
      <div className="progress-fill" style={{ width: `${percentage}%` }} />
    </div>
  );
}
