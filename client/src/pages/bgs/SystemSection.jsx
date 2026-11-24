import { buildSystemReport } from '../../bgs-report.js';
import DataTable from '../../components/DataTable.jsx';
import { Badge, Section } from '../../components/ui.jsx';
import { formatDateTime, formatSystemName } from '../../format.js';
import { ACTIVITY_COLUMNS, CONFLICT_BADGE_TONES, CONFLICT_LABELS, renderActivityValue } from './bgs-activity.jsx';
import { CopyReportButton } from './CopyReportButton.jsx';

export function SystemSection({ system, includeSecondaryInf, isIncluded, onToggleIncluded, adjustTitle, onAdjust }) {
  const visibleColumns = ACTIVITY_COLUMNS.filter((column) => system.factions.some((faction) => column.getValue(faction.totals, includeSecondaryInf)));
  const systemName = system.starSystem ?? `System #${system.systemAddress}`;

  return (
    <Section
      title={formatSystemName(systemName)}
      description={`Last activity ${formatDateTime(system.lastActivityAt)}`}
      actions={(
        <>
          <label className="checkbox" title="Include this system in Copy All">
            <input type="checkbox" checked={isIncluded} onChange={onToggleIncluded} />
            Include in Copy All
          </label>
          <CopyReportButton label="Copy" getReport={() => buildSystemReport(system, { includeSecondaryInf }) ?? ''} />
        </>
      )}
    >
      <DataTable
        tableId="bgs.factions"
        rowKey="name"
        rows={system.factions}
        emptyMessage="No faction activity."
        columns={[
          {
            key: 'name',
            label: 'Faction',
            render: (faction) => (
              <>
                {faction.name}
                {faction.state && <> <Badge tone={CONFLICT_BADGE_TONES[faction.state]}>{CONFLICT_LABELS[faction.state]}</Badge></>}
              </>
            ),
          },
          ...visibleColumns.map((column) => ({
            key: column.key,
            label: column.key === 'inf' ? 'INF' : column.label,
            align: 'right',
            sortValue: (faction) => column.getValue(faction.totals, includeSecondaryInf) ?? null,
            render: (faction) => renderActivityValue(column, faction, includeSecondaryInf),
          })),
          {
            key: 'adjust',
            label: '',
            shrink: true,
            align: 'right',
            render: (faction) => (
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit ${faction.name} activity`}
                title={adjustTitle ?? 'Edit activity totals'}
                disabled={!onAdjust}
                onClick={() => onAdjust(faction)}
              >
                ✎
              </button>
            ),
          },
        ]}
      />
    </Section>
  );
}
