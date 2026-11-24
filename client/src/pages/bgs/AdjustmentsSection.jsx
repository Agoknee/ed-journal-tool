import { useState } from 'react';
import { deleteJson } from '../../api.js';
import { ADJUSTMENT_FIELDS } from '../../bgs-adjustment-fields.js';
import { formatBgsNumber } from '../../bgs-report.js';
import DataTable from '../../components/DataTable.jsx';
import { LoadingState, Section } from '../../components/ui.jsx';
import { formatDateTime, formatFullCredits, formatSystemName } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';

const ADJUSTMENTS_PER_PAGE = 20;

/** Every manual adjustment, newest tick first, with a way to edit or delete it. */
export function AdjustmentsSection({ commanderFilter, onEdit }) {
  const adjustmentsRequest = useApi('/api/bgs-adjustments', { commander: commanderFilter }, ['adjustments']);
  const [deleteError, setDeleteError] = useState(null);

  const deleteAdjustment = async (adjustment) => {
    const fieldLabel = ADJUSTMENT_FIELDS[adjustment.field]?.fullLabel ?? adjustment.field;
    if (!window.confirm(`Delete the ${fieldLabel} adjustment for ${adjustment.faction} in ${adjustment.starSystem}?`)) return;
    try {
      setDeleteError(null);
      await deleteJson(`/api/bgs-adjustments/${adjustment.id}`);
    } catch (error) {
      setDeleteError(error.message);
    }
  };

  return (
    <Section
      id="bgs-adjustments"
      title="Manual Adjustments"
      description="Corrections entered by hand, added on top of the tracked activity for their tick. Use the ✎ button on a faction, or Add Activity, to make them."
    >
      {deleteError && <div className="notice notice-error">{deleteError}</div>}
      <LoadingState requestState={adjustmentsRequest}>
        {({ adjustments }) => (
          <DataTable
            tableId="bgs.adjustments"
            rowKey="id"
            rows={adjustments}
            pageSize={ADJUSTMENTS_PER_PAGE}
            emptyMessage="No manual adjustments."
            columns={[
              { key: 'tick', label: 'Tick', render: (adjustment) => formatDateTime(adjustment.tick) },
              ...(commanderFilter === 'all' ? [{ key: 'commanderName', label: 'Commander', render: (adjustment) => `CMDR ${adjustment.commanderName}` }] : []),
              { key: 'starSystem', label: 'System', render: (adjustment) => formatSystemName(adjustment.starSystem) },
              { key: 'faction', label: 'Faction' },
              { key: 'field', label: 'Type', sortValue: (adjustment) => getFieldLabel(adjustment.field), render: (adjustment) => getFieldLabel(adjustment.field) },
              {
                key: 'value',
                label: 'Adjustment',
                align: 'right',
                render: (adjustment) => {
                  const isCredits = ADJUSTMENT_FIELDS[adjustment.field]?.isCredits;
                  const text = isCredits ? formatBgsNumber(adjustment.value) : String(adjustment.value);
                  return <span title={isCredits ? formatFullCredits(adjustment.value) : undefined}>{adjustment.value > 0 ? `+${text}` : text}</span>;
                },
              },
              { key: 'updatedAt', label: 'Updated', render: (adjustment) => formatDateTime(adjustment.updatedAt) },
              {
                key: 'actions',
                label: '',
                align: 'right',
                shrink: true,
                render: (adjustment) => (
                  <span className="bgs-row-actions">
                    <button type="button" className="icon-button" aria-label="Edit" title="Edit this faction's totals for the tick" onClick={() => onEdit(adjustment)}>✎</button>
                    <button type="button" className="icon-button icon-button-danger" aria-label="Delete" title="Delete this adjustment" onClick={() => deleteAdjustment(adjustment)}>✕</button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </LoadingState>
    </Section>
  );
}

function getFieldLabel(field) {
  return ADJUSTMENT_FIELDS[field]?.fullLabel ?? field;
}
