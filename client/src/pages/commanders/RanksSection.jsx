import { useEffect, useRef, useState } from 'react';
import DataTable from '../../components/DataTable.jsx';
import RankIcon from '../../components/RankIcon.jsx';
import { getPowerImageUrl, getRankImageUrl, getSuperpowerImageUrl } from '../../components/inara-images.js';
import { Badge, LoadingState, Section, StatCard, StatGrid } from '../../components/ui.jsx';
import { useApi } from '../../hooks/use-api.js';
import { formatDateTime, formatNumber, formatSystemName } from '../../format.js';

const PILOT_RANKS = [
  { key: 'Combat', label: 'Combat' },
  { key: 'Trade', label: 'Trade' },
  { key: 'Explore', label: 'Exploration' },
  { key: 'Exobiologist', label: 'Exobiology' },
  { key: 'Soldier', label: 'Mercenary' },
  { key: 'CQC', label: 'CQC' },
];
const NAVY_RANKS = [
  { key: 'Federation', label: 'Federal Navy' },
  { key: 'Empire', label: 'Imperial Navy' },
];
const MAJOR_FACTIONS = [
  { key: 'Federation', label: 'Federation' },
  { key: 'Empire', label: 'Empire' },
  { key: 'Alliance', label: 'Alliance' },
  { key: 'Independent', label: 'Independent' },
];

/** Reputation standing names, from the game's thresholds (-100 to 100). */
function getStanding(reputation) {
  if (reputation === null || reputation === undefined) return { label: 'Unknown', tone: 'neutral' };
  if (reputation >= 90) return { label: 'Allied', tone: 'live' };
  if (reputation >= 35) return { label: 'Friendly', tone: 'info' };
  if (reputation > 4) return { label: 'Cordial', tone: 'neutral' };
  if (reputation >= -35) return { label: 'Neutral', tone: 'neutral' };
  if (reputation > -90) return { label: 'Unfriendly', tone: 'warning' };
  return { label: 'Hostile', tone: 'danger' };
}

/** Pilots' Federation and navy ranks, major faction reputation, Powerplay and minor factions. */
export default function RanksSection({ commanderId, picker }) {
  const profileRequest = useApi(commanderId ? '/api/stats/commanders' : null, { commander: commanderId });
  const reputationRequest = useApi(commanderId ? '/api/stats/reputation' : null, { commander: commanderId });
  const profile = profileRequest.data?.commanders?.[0];

  return (
    <Section id="commanders-ranks" title="Ranks & Reputation" description="Pilots’ Federation and navy ranks, reputation with the superpowers and minor factions, and Powerplay." actions={picker}>
      <LoadingState requestState={profileRequest}>
        {() => profile && (
          <>
            <div className="rank-grid">
              {PILOT_RANKS.map((rank) => (
                <RankCard key={rank.key} rank={rank} profile={profile} />
              ))}
              {NAVY_RANKS.map((rank) => (
                <RankCard key={rank.key} rank={rank} profile={profile} />
              ))}
            </div>

            <h3 className="subsection-title">Superpower reputation</h3>
            <div className="reputation-grid">
              {MAJOR_FACTIONS.map((faction) => (
                <ReputationCard key={faction.key} faction={faction} reputation={profile.reputation?.[faction.key]} />
              ))}
            </div>
          </>
        )}
      </LoadingState>

      <LoadingState requestState={reputationRequest}>
        {({ powerplay, factions }) => (
          <>
            <h3 className="subsection-title">Powerplay</h3>
            <PowerplayPanel powerplay={powerplay[0]} />
            <MinorFactions factions={factions ?? []} />
          </>
        )}
      </LoadingState>
    </Section>
  );
}

function RankCard({ rank, profile }) {
  const rankIndex = profile.ranks?.[rank.key];
  if (rankIndex === undefined) return null;
  const progress = profile.rank_progress?.[rank.key] ?? 0;
  const nextName = profile.next_rank_names?.[rank.key];
  return (
    <div className="rank-card">
      <RankIcon size={52} title={`${rank.label}: ${profile.rank_names?.[rank.key]}`} imageUrl={getRankImageUrl(rank.key, rankIndex)} />
      <div className="rank-card-body">
        <div className="rank-card-label">{rank.label}</div>
        <div className="rank-card-name">{profile.rank_names?.[rank.key] ?? '—'}</div>
        {nextName ? (
          <div className="rank-card-progress" title={`${progress}% of the way to ${nextName}`}>
            <div className="progress"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            <span className="muted small">{progress}% to {nextName}</span>
          </div>
        ) : <span className="muted small">Top rank</span>}
      </div>
    </div>
  );
}

function ReputationCard({ faction, reputation }) {
  const standing = getStanding(reputation);
  const value = reputation ?? 0;
  // A bar from -100 to 100, filled from the centre towards the reputation.
  const fillStyle = value >= 0 ? { left: '50%', width: `${value / 2}%` } : { left: `${50 + value / 2}%`, width: `${-value / 2}%` };
  return (
    <div className="reputation-card">
      <RankIcon size={44} title={faction.label} imageUrl={getSuperpowerImageUrl(faction.key)} />
      <div className="rank-card-body">
        <div className="rank-card-label">{faction.label}</div>
        <div className="reputation-card-value">
          <Badge tone={standing.tone}>{standing.label}</Badge>
          <span className="muted small">{reputation === undefined ? '—' : `${value.toFixed(1)}%`}</span>
        </div>
        <div className={`reputation-bar ${value < 0 ? 'reputation-bar-negative' : ''}`}>
          <div className="reputation-bar-fill" style={fillStyle} />
          <div className="reputation-bar-centre" />
        </div>
      </div>
    </div>
  );
}

function PowerplayPanel({ powerplay }) {
  const [weekAgo] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  // The portrait is square and as tall as the first row of cards, which depends on their content.
  const cardsRef = useRef(null);
  const [portraitSize, setPortraitSize] = useState(null);
  useEffect(() => {
    const firstCard = cardsRef.current?.querySelector('.stat-card');
    if (!firstCard) return undefined;
    const observer = new ResizeObserver(() => setPortraitSize(Math.round(firstCard.getBoundingClientRect().height)));
    observer.observe(firstCard);
    return () => observer.disconnect();
  }, [powerplay?.power]);
  if (!powerplay?.power) return <div className="notice">Not pledged to a power.</div>;
  const meritsThisWeek = powerplay.dailyMerits.filter((day) => day.day >= weekAgo).reduce((total, day) => total + day.merits, 0);
  const pledgedDays = powerplay.timePledgedSeconds ? Math.floor(powerplay.timePledgedSeconds / 86_400) : null;
  return (
    <div className="powerplay-panel">
      <div className="powerplay-power">{powerplay.power}</div>
      {/* The portrait sits beside the cards, as tall as they are. */}
      <div className="powerplay-row">
        <RankIcon className="powerplay-portrait" size={portraitSize ?? 96} title={powerplay.power} imageUrl={getPowerImageUrl(powerplay.power)} />
        <div className="powerplay-cards" ref={cardsRef}>
          <StatGrid>
            <StatCard label="Rank" value={formatNumber(powerplay.rank)} tone="accent" />
            <StatCard label="Merits" value={formatNumber(powerplay.merits)} detail={`${formatNumber(meritsThisWeek)} in the last 7 days`} />
            <StatCard label="Pledged" value={pledgedDays === null ? '—' : `${formatNumber(pledgedDays)} days`} />
          </StatGrid>
        </div>
      </div>
      <p className="muted small">As of {formatDateTime(powerplay.updatedAt)}</p>
    </div>
  );
}

function MinorFactions({ factions }) {
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLowerCase();
  const rows = factions
    .filter((faction) => !normalizedSearch || [faction.faction, faction.starSystem, faction.allegiance].some((value) => value?.toLowerCase().includes(normalizedSearch)))
    .map((faction) => ({ ...faction, standing: getStanding(faction.reputation) }));
  const counts = factions.reduce((totals, faction) => {
    const { label } = getStanding(faction.reputation);
    totals[label] = (totals[label] ?? 0) + 1;
    return totals;
  }, {});
  return (
    <>
      <div className="section-toolbar">
        <h3 className="subsection-title">Minor factions</h3>
        <input type="search" className="toolbar-search" placeholder="Search faction or system…" value={search} onChange={(changeEvent) => setSearch(changeEvent.target.value)} />
      </div>
      <p className="muted small">
        {['Allied', 'Friendly', 'Cordial', 'Neutral', 'Unfriendly', 'Hostile'].filter((label) => counts[label]).map((label) => `${formatNumber(counts[label])} ${label.toLowerCase()}`).join(' · ') || 'None yet'}.
        {' '}Reputation is logged for the factions in each system you visit, as of your last visit.
      </p>
      <DataTable
        tableId="commanders.minorFactions"
        rowKey="faction"
        rows={rows}
        pageSize={5}
        pageResetKey={normalizedSearch}
        emptyMessage="No minor factions recorded."
        columns={[
          { key: 'faction', label: 'Faction', wrap: true },
          { key: 'reputation', label: 'Standing', render: (faction) => <Badge tone={faction.standing.tone}>{faction.standing.label}</Badge> },
          { key: 'reputationValue', label: 'Reputation', align: 'right', sortValue: (faction) => faction.reputation, render: (faction) => `${faction.reputation.toFixed(1)}%` },
          { key: 'allegiance', label: 'Allegiance', render: (faction) => faction.allegiance ?? '—' },
          { key: 'government', label: 'Government', render: (faction) => faction.government ?? '—' },
          { key: 'starSystem', label: 'Seen in', render: (faction) => formatSystemName(faction.starSystem) ?? '—' },
          { key: 'updatedAt', label: 'As of', render: (faction) => formatDateTime(faction.updatedAt) },
        ]}
      />
    </>
  );
}
