import CopyableText from '../../components/CopyableText.jsx';
import DataTable from '../../components/DataTable.jsx';
import { Badge, LoadingState, Section } from '../../components/ui.jsx';
import { formatDateTime, formatRelativeTime } from '../../format.js';
import { formatTickLength } from './bgs-periods.js';

const TICKS_PER_PAGE = 10;

/**
 * Saved ticks, newest first, with how long each tick period lasted. "Show Activity" switches the
 * page to that tick's period; clicking the tick time copies a Discord timestamp of it.
 */
export function TickHistorySection({ ticksRequest, selectedPeriodId, onShowActivity }) {
  return (
    <Section
      id="bgs-tick-history"
      title="Tick History"
      description={(
        <>
          BGS ticks seen while the app was running (from <a href="http://tick.infomancer.uk/" target="_blank" rel="noreferrer">tick.infomancer.uk</a>).
          {' '}Times are in your local time zone. Click a tick time to copy it as a Discord timestamp.
        </>
      )}
    >
      <LoadingState requestState={ticksRequest}>
        {({ ticks }) => {
          const rows = ticks.map((tickTime, tickIndex) => ({
            tickTime,
            periodId: tickIndex === 0 ? 'current' : `tick:${tickTime}`,
            // The newest tick's period is still running, so it has no end yet.
            durationMs: tickIndex === 0 ? null : Date.parse(ticks[tickIndex - 1]) - Date.parse(tickTime),
          }));
          return (
            <DataTable
              tableId="bgs.ticks"
              rowKey="tickTime"
              rows={rows}
              pageSize={TICKS_PER_PAGE}
              emptyMessage="No ticks seen yet."
              columns={[
                {
                  key: 'tickTime',
                  label: 'Tick',
                  render: (row) => (
                    <>
                      <CopyableText copyText={`<t:${Math.floor(Date.parse(row.tickTime) / 1000)}:f>`} title="Copies a Discord timestamp">
                        {formatDateTime(row.tickTime)}
                      </CopyableText>
                      {row.periodId === 'current' && <> <Badge tone="accent">Current</Badge></>}
                    </>
                  ),
                },
                { key: 'age', label: 'Age', sortValue: (row) => row.tickTime, render: (row) => formatRelativeTime(row.tickTime) },
                {
                  key: 'durationMs',
                  label: 'Tick Length',
                  align: 'right',
                  sortValue: (row) => row.durationMs,
                  render: (row) => (row.durationMs === null ? 'In Progress' : formatTickLength(row.durationMs)),
                },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  shrink: true,
                  render: (row) => (
                    <button type="button" disabled={row.periodId === selectedPeriodId} onClick={() => onShowActivity(row.periodId)}>
                      {row.periodId === selectedPeriodId ? 'Showing' : 'Show Activity'}
                    </button>
                  ),
                },
              ]}
            />
          );
        }}
      </LoadingState>
    </Section>
  );
}
