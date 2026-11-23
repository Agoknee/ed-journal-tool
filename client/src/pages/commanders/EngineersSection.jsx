import { useState } from 'react';
import { getEngineerImageUrl } from '../../components/inara-images.js';
import { Badge, LoadingState, Section, StatCard, StatGrid, Tabs } from '../../components/ui.jsx';
import { useApi } from '../../hooks/use-api.js';
import { formatDateTime, formatNumber, formatSystemName } from '../../format.js';

const ENGINEER_FILTERS = [
  { id: 'ship', label: 'Ship engineers' },
  { id: 'onFoot', label: 'On-foot engineers' },
  { id: 'all', label: 'All' },
];
const PROGRESS_ORDER = { Unlocked: 0, Acquainted: 1, Invited: 2, Known: 3, Barred: 4 };
const PROGRESS_TONES = { Unlocked: 'live', Acquainted: 'info', Invited: 'warning', Known: 'neutral', Barred: 'danger' };
const MAX_ENGINEER_RANK = 5;

/** Every engineer the commander knows of: standing, rank, blueprints crafted and modules they've engineered. */
export default function EngineersSection({ commanderId, picker }) {
  const [filterId, setFilterId] = useState('ship');
  const engineersRequest = useApi(commanderId ? '/api/stats/engineers' : null, { commander: commanderId });

  return (
    <Section
      id="commanders-engineers"
      title="Engineers"
      description="Pinned blueprints aren’t recorded in the journal, so they can’t be shown here."
      actions={picker}
    >
      <LoadingState requestState={engineersRequest}>
        {({ engineers, preEngineeredModuleCount }) => {
          const people = engineers.filter((engineer) => !engineer.isRemoteWorkshop);
          const unlocked = people.filter((engineer) => engineer.progress === 'Unlocked');
          const shown = people
            .filter((engineer) => filterId === 'all' || (filterId === 'onFoot' ? engineer.isOnFoot : !engineer.isOnFoot))
            .sort((first, second) => (PROGRESS_ORDER[first.progress] ?? 9) - (PROGRESS_ORDER[second.progress] ?? 9)
              || (second.rank ?? 0) - (first.rank ?? 0) || first.engineer.localeCompare(second.engineer));
          const remote = engineers.find((engineer) => engineer.isRemoteWorkshop);
          return (
            <>
              <StatGrid>
                <StatCard label="Unlocked" value={`${formatNumber(unlocked.length)} / ${formatNumber(people.length)}`} tone="accent" />
                <StatCard label="At grade 5" value={formatNumber(unlocked.filter((engineer) => engineer.rank === MAX_ENGINEER_RANK).length)} />
                <StatCard label="Blueprints crafted" value={formatNumber(engineers.reduce((total, engineer) => total + engineer.craftCount, 0))} detail={remote ? `${formatNumber(remote.craftCount)} applied remotely` : null} />
                <StatCard
                  label="Engineered modules"
                  value={formatNumber(engineers.reduce((total, engineer) => total + engineer.modules.length, 0))}
                  detail={preEngineeredModuleCount > 0 ? `on ships you own · plus ${formatNumber(preEngineeredModuleCount)} pre-engineered` : 'on ships you own'}
                  title="Made by an engineer. Modules bought pre-engineered have no engineer, so they aren’t listed under one."
                />
              </StatGrid>
              <Tabs tabs={ENGINEER_FILTERS} activeTab={filterId} onChange={setFilterId} />
              <div className="card-grid engineer-grid">
                {shown.map((engineer) => <EngineerCard key={engineer.engineerId} engineer={engineer} />)}
              </div>
              {shown.length === 0 && <div className="notice">No engineers here yet.</div>}
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}

function EngineerCard({ engineer }) {
  const isUnlocked = engineer.progress === 'Unlocked';
  const topBlueprints = [...engineer.blueprints].sort((first, second) => second.craftCount - first.craftCount);
  return (
    <article className={`card engineer-card ${isUnlocked ? '' : 'engineer-card-locked'}`}>
      <header className="card-header">
        <div className="engineer-identity">
          {engineer.imageId && <img className="engineer-portrait" src={getEngineerImageUrl(engineer.imageId)} alt="" width={56} height={56} />}
          <div>
            <h3>{engineer.engineer}</h3>
            <div className="muted small">{engineer.system ? formatSystemName(engineer.system) : 'Location unknown'}{engineer.isOnFoot ? ' · on foot' : ''}</div>
          </div>
        </div>
        <Badge tone={PROGRESS_TONES[engineer.progress] ?? 'neutral'}>{engineer.progress ?? 'Unknown'}</Badge>
      </header>
      {engineer.modifications.length > 0 && (
        <div className="engineer-mods">
          {engineer.modifications.map((modification) => (
            <span key={modification.name} className="engineer-mod" title={`${modification.name} up to grade ${modification.grade}`}>
              {modification.name} <span className="muted">G{modification.grade}</span>
            </span>
          ))}
        </div>
      )}
      {isUnlocked && engineer.rank !== null && (
        <div className="engineer-rank" title={engineer.rank < MAX_ENGINEER_RANK ? `${engineer.rankProgress ?? 0}% towards grade ${engineer.rank + 1}` : 'Highest grade unlocked'}>
          <span className="engineer-grade-pips" aria-label={`Grade ${engineer.rank} of ${MAX_ENGINEER_RANK}`}>
            {Array.from({ length: MAX_ENGINEER_RANK }, (unused, index) => (
              <span key={index} className={index < engineer.rank ? 'engineer-grade-pip engineer-grade-pip-on' : 'engineer-grade-pip'} />
            ))}
          </span>
          <span className="small">Grade {engineer.rank}{engineer.rank < MAX_ENGINEER_RANK ? ` · ${engineer.rankProgress ?? 0}% to ${engineer.rank + 1}` : ''}</span>
        </div>
      )}
      <div className="engineer-stats small">
        <span><strong>{formatNumber(engineer.craftCount)}</strong> <span className="muted">crafts</span></span>
        <span><strong>{formatNumber(engineer.modules.length)}</strong> <span className="muted">modules fitted</span></span>
        {engineer.lastCraftAt && <span className="muted">last {formatDateTime(engineer.lastCraftAt)}</span>}
      </div>
      {topBlueprints.length > 0 && (
        <details className="engineer-details">
          <summary className="small">Blueprints crafted ({topBlueprints.length})</summary>
          <ul className="engineer-list">
            {topBlueprints.map((blueprint) => (
              <li key={`${blueprint.blueprint}-${blueprint.level}`}>
                <span>{blueprint.blueprint} <span className="muted">G{blueprint.level}</span></span>
                <span className="muted">{formatNumber(blueprint.craftCount)}×{blueprint.experimentals ? ` · ${blueprint.experimentals} experimental` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {engineer.modules.length > 0 && (
        <details className="engineer-details">
          <summary className="small">Modules on your ships ({engineer.modules.length})</summary>
          <ul className="engineer-list">
            {engineer.modules.map((module, index) => (
              <li key={index}>
                <span>{module.blueprint} <span className="muted">G{module.level}</span>{module.experimental && <span className="muted"> · {module.experimental}</span>}</span>
                <span className="muted">{module.shipName ?? module.shipType} · {module.slot}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
