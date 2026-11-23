import { useEffect, useState } from 'react';
import { copyToClipboard } from '../../clipboard.js';
import DataTable from '../../components/DataTable.jsx';
import { LoadingState, ProgressBar, Section, StatCard, StatGrid } from '../../components/ui.jsx';
import { formatCredits, formatDateTime, formatFullCredits, formatNumber, formatRelativeTime, formatSystemName } from '../../format.js';
import { useApi } from '../../hooks/use-api.js';
import { CombatSessionPanel } from './CombatSessionPanel.jsx';
import { getStationNames, renderExpiry, renderFactionName, renderMissionFaction, renderStatus, renderWingReward } from './mission-display.jsx';

export function MassacreSection({ commanderFilter }) {
  const massacreRequest = useApi('/api/stats/missions/massacre', { commander: commanderFilter });
  const combatRequest = useApi('/api/stats/combat/status', { commander: commanderFilter });
  const combatByCommander = new Map((combatRequest.data?.commanders ?? []).map((combat) => [combat.commanderId, combat]));
  const shipStatusRequest = useApi('/api/ship-status', {}, ['shipStatus', 'journals']);
  const shipStatusByCommander = new Map((shipStatusRequest.data?.commanders ?? []).map((status) => [status.commanderId, status]));
  return (
    <Section
      id="missions-massacre"
      title="Massacre Stacks"
      description="Open massacre missions grouped by target. Each kill counts for one mission from every issuing faction at once, so a stack needs as many kills as its largest faction. Not all kills are logged in your journal, so the tracked count can lag until the game marks a mission complete."
    >
      <LoadingState requestState={massacreRequest}>
        {({ stacks }) => (stacks.length === 0
          ? <div className="notice">No open massacre missions.</div>
          : stacks.map((stack) => (
            <MassacreStack
              key={stack.key}
              stack={stack}
              combat={combatByCommander.get(stack.commanderId)}
              shipStatus={shipStatusByCommander.get(stack.commanderId) ?? null}
              showCommander={commanderFilter === 'all'}
            />
          )))}
      </LoadingState>
    </Section>
  );
}

function MassacreStack({ stack, combat, shipStatus, showCommander }) {
  const { totals } = stack;
  const stationNames = getStationNames(stack.missions);
  const targetLabel = [stack.targetType, stack.isOnFoot ? '(on foot)' : null].filter(Boolean).join(' ');
  return (
    <div className="card mission-stack">
      <header className="mission-stack-header">
        <div>
          <h3>{stack.targetFaction}</h3>
          <div className="muted small">
            {[targetLabel, stack.targetSystem && `in ${formatSystemName(stack.targetSystem)}`, showCommander && `CMDR ${stack.commanderName}`].filter(Boolean).join(' · ')}
          </div>
          {stack.currentSystem && stack.factions.some((faction) => faction.isPresent) && (
            <div className="small">
              <span className="mission-faction-present">Highlighted</span>
              <span className="muted"> factions are present in {formatSystemName(stack.currentSystem)}, where you are now.</span>
            </div>
          )}
        </div>
        <div className="mission-stack-progress">
          <span className="mission-stack-kills">
            <strong>{formatNumber(totals.kills)}</strong> / {formatNumber(totals.killsRequired)} kills
          </span>
          <ProgressBar value={totals.kills} max={totals.killsRequired} />
          <span className="muted small">{formatNumber(totals.killsRemaining)} remaining</span>
        </div>
      </header>

      {isCombatForStack(combat, stack) && <CombatSessionPanel combat={combat} shipStatus={shipStatus} targetFaction={stack.targetFaction} killsRemaining={totals.killsRemaining} />}

      <StatGrid>
        <StackRewardCard stack={stack} />
        <StatCard label="Per kill" value={formatCredits(totals.rewardPerKill)} />
        <StatCard label="Per mission" value={formatCredits(totals.missionCount ? totals.reward / totals.missionCount : 0)} />
        <StatCard label="Missions" value={formatNumber(totals.missionCount)}
          detail={(
            <>
              <span title="Objective complete; return to the issuing station to hand in">{formatNumber(totals.redirectedCount)} complete</span>
              {' · '}
              <span title={stationNames.join(', ')}>{formatNumber(stationNames.length)} {stationNames.length === 1 ? 'station' : 'stations'}</span>
            </>
          )} />
        <StatCard label="Stack ratio" value={`${totals.killRatio.toFixed(2)}×`} detail={`${formatNumber(totals.totalKillCount)} kills across missions`} />
        <StatCard label="Next expiry" value={totals.nextExpiry ? formatRelativeTime(totals.nextExpiry) : '—'}
          detail={totals.nextExpiry ? formatDateTime(totals.nextExpiry) : null} />
      </StatGrid>

      <DataTable
        tableId="missions.massacreFactions"
        rowKey="faction"
        rows={stack.factions}
        columns={[
          {
            key: 'faction',
            label: 'Issuing Faction',
            wrap: true,
            render: (row) => renderFactionName(row.faction, row.isPresent, stack.currentSystem),
          },
          { key: 'missionCount', label: 'Missions', align: 'right', render: (row) => (row.redirectedCount ? `${row.missionCount} (${row.redirectedCount} done)` : row.missionCount) },
          {
            key: 'progress',
            label: 'Kills',
            sortValue: (row) => row.kills / (row.killsRequired || 1),
            render: (row) => (
              <span className="mission-progress-cell">
                <ProgressBar value={row.kills} max={row.killsRequired} />
                <span>{formatNumber(row.kills)} / {formatNumber(row.killsRequired)}</span>
              </span>
            ),
          },
          { key: 'remaining', label: 'Remaining', align: 'right', render: (row) => formatNumber(row.remaining) },
          {
            key: 'difference',
            label: 'Difference',
            align: 'right',
            render: (row) => (row.difference ? <span title="Kills fewer than the largest faction; room to stack more missions">−{formatNumber(row.difference)}</span> : <span className="muted">—</span>),
          },
          { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
          { key: 'stations', label: 'Stations', wrap: true, sortValue: (row) => row.stations.join(', '), render: (row) => row.stations.join(', ') || '—' },
        ]}
      />

      <details className="details">
        <summary>Show {totals.missionCount} {totals.missionCount === 1 ? 'mission' : 'missions'}</summary>
        <DataTable
          tableId="missions.massacreMissions"
          rows={stack.missions}
          columns={[
            { key: 'faction', label: 'Faction', wrap: true, render: renderMissionFaction },
            { key: 'origin_station', label: 'Station', render: (row) => row.origin_station ?? '—' },
            { key: 'kill_count', label: 'Kills', sortValue: (row) => row.kills / (row.kill_count || 1), render: (row) => `${formatNumber(Math.min(row.kills, row.kill_count))} / ${formatNumber(row.kill_count)}` },
            { key: 'reward', label: 'Reward', align: 'right', render: (row) => <span title={formatFullCredits(row.reward)}>{formatCredits(row.reward)}</span> },
            { key: 'status', label: 'Status', render: renderStatus },
            { key: 'expiry', label: 'Expires', render: renderExpiry },
            { key: 'accepted_at', label: 'Accepted', render: (row) => formatDateTime(row.accepted_at) },
          ]}
        />
      </details>
    </div>
  );
}

/**
 * The combat panel is for the commander playing right now in the stack's target system: their
 * journal is active, they're in that system, and their latest session was there.
 */
function isCombatForStack(combat, stack) {
  if (!combat?.isJournalActive || !stack.targetSystem) return false;
  const targetSystem = stack.targetSystem.toLowerCase();
  return combat.currentSystem?.toLowerCase() === targetSystem && combat.session.system?.toLowerCase() === targetSystem;
}

const COPIED_MESSAGE_MS = 1500;

/**
 * The stack's reward. With wing missions in the stack, clicking copies the wing-shareable amount
 * and how many stations those missions came from, e.g. "286.17M cr (2 stations)".
 */
function StackRewardCard({ stack }) {
  const { totals } = stack;
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'
  useEffect(() => {
    if (!copyStatus) return undefined;
    const resetTimer = setTimeout(() => setCopyStatus(null), COPIED_MESSAGE_MS);
    return () => clearTimeout(resetTimer);
  }, [copyStatus]);

  if (!totals.wingReward) return <StatCard label="Reward" value={formatCredits(totals.reward)} tone="accent" />;

  const wingStationCount = getStationNames(stack.missions.filter((mission) => mission.is_wing)).length;
  const copyText = `${formatCredits(totals.wingReward)} (${wingStationCount} ${wingStationCount === 1 ? 'station' : 'stations'})`;
  const copy = async () => setCopyStatus((await copyToClipboard(copyText)) ? 'copied' : 'failed');
  return (
    <button type="button" className="stat-card stat-card-accent stat-card-button" onClick={copy} title={`Click to copy the wing-shareable reward (${formatFullCredits(totals.wingReward)}): ${copyText}`}>
      <div className="stat-label">Reward</div>
      <div className="stat-value">{formatCredits(totals.reward)}</div>
      <div className="stat-detail">
        {copyStatus
          ? <span className={`copy-status-text-${copyStatus}`}>{copyStatus === 'copied' ? `Copied ${copyText}` : 'Copy failed'}</span>
          : renderWingReward(totals.wingReward)}
      </div>
    </button>
  );
}
