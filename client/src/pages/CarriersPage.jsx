import { LoadingState, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { formatCredits } from '../format.js';
import { useApi } from '../hooks/use-api.js';
import { STORED_BOOLEAN, storedChoice, useStoredState } from '../hooks/use-stored-state.js';
import { compareTimestamps, getCarrierLabel } from './carriers/carrier-display.jsx';
import { CarrierCard } from './carriers/CarrierCard.jsx';
import { CarrierHistorySection } from './carriers/CarrierHistorySection.jsx';
import { CarrierOverviewTable } from './carriers/CarrierOverviewTable.jsx';
import './carriers/carriers.css';

const CARD_SORT_STORAGE_KEY = 'carriers.cardSort';

const SHOW_CARRIERLESS_STORAGE_KEY = 'carriers.showCommandersWithoutCarrier';

const SHOW_UNOWNED_STORAGE_KEY = 'carriers.showUnownedCarriers';

/** Card sort options. Carriers with an unknown age or activity time are listed last. */
const CARD_SORTS = {
  age: { label: 'Age (Oldest First)', compare: (first, second) => compareTimestamps(first.acquired_at, second.acquired_at, 'asc') },
  name: { label: 'Name', compare: (first, second) => getCarrierLabel(first).localeCompare(getCarrierLabel(second), undefined, { sensitivity: 'base' }) },
  activity: { label: 'Activity (Most Recent First)', compare: (first, second) => compareTimestamps(first.updated_at, second.updated_at, 'desc') },
};

export default function CarriersPage({ commanderFilter }) {
  const carriersRequest = useApi('/api/stats/carriers', { commander: commanderFilter }, ['stats', 'notes']);
  const [cardSort, changeCardSort] = useStoredState(CARD_SORT_STORAGE_KEY, 'age', storedChoice(Object.keys(CARD_SORTS)));
  const [showCommandersWithoutCarrier, changeShowCommandersWithoutCarrier] = useStoredState(SHOW_CARRIERLESS_STORAGE_KEY, false, STORED_BOOLEAN);
  const [showUnownedCarriers, changeShowUnownedCarriers] = useStoredState(SHOW_UNOWNED_STORAGE_KEY, false, STORED_BOOLEAN);

  return (
    <>
      <LoadingState requestState={carriersRequest}>
        {({ carriers, commanderStatuses }) => {
          const activeCarriers = carriers.filter((carrier) => !carrier.is_decommissioned);
          // Only carriers a commander owns; squadron carriers they're merely linked to aren't theirs to spend.
          const ownedCarrierIds = new Set(commanderStatuses.flatMap((status) => [...status.fleetCarrierIds, ...status.squadronCarrierIds]));
          // Unowned carriers (linked squadron carriers, decommissioned ones) are hidden unless toggled on,
          // and then come after the owned ones, each group in the chosen order.
          const cardCarriers = showUnownedCarriers ? carriers : carriers.filter((carrier) => ownedCarrierIds.has(carrier.carrier_id));
          const sortedCarriers = [...cardCarriers].sort((first, second) => (
            Number(ownedCarrierIds.has(second.carrier_id)) - Number(ownedCarrierIds.has(first.carrier_id))
            || CARD_SORTS[cardSort].compare(first, second)
          ));
          const ownedCarriers = activeCarriers.filter((carrier) => ownedCarrierIds.has(carrier.carrier_id));
          const totalBalance = ownedCarriers.reduce((total, carrier) => total + (carrier.finance?.carrierBalance ?? 0), 0);
          return (
            <>
              <Section
                title="Overview"
                description="Click a commander, squadron, carrier name, ID, system or jump timer to copy it. Double-click a note to edit it."
                actions={(
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showCommandersWithoutCarrier}
                      onChange={(changeEvent) => changeShowCommandersWithoutCarrier(changeEvent.target.checked)}
                    />
                    Show Commanders With No Carrier
                  </label>
                )}
              >
                <StatGrid>
                  <StatCard label="Fleet carriers" value={ownedCarriers.filter((carrier) => carrier.carrier_type === 'FleetCarrier').length} />
                  <StatCard label="Squadron carriers" value={ownedCarriers.filter((carrier) => carrier.carrier_type === 'SquadronCarrier').length} />
                  <StatCard label="Combined balance" value={formatCredits(totalBalance)} />
                  <StatCard label="Commanders with carriers" value={`${commanderStatuses.filter((status) => status.carrierStatus !== 'None').length} / ${commanderStatuses.length}`} />
                </StatGrid>
                <CarrierOverviewTable commanderStatuses={commanderStatuses} carriers={carriers} includeCommandersWithoutCarrier={showCommandersWithoutCarrier} />
              </Section>

              <Section
                id="carrier-details"
                title="Carriers"
                actions={(
                  <>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={showUnownedCarriers}
                        onChange={(changeEvent) => changeShowUnownedCarriers(changeEvent.target.checked)}
                      />
                      Show Unowned Carriers
                    </label>
                    <select value={cardSort} onChange={(changeEvent) => changeCardSort(changeEvent.target.value)} aria-label="Sort carriers">
                      {Object.entries(CARD_SORTS).map(([sortName, sortOption]) => <option key={sortName} value={sortName}>Sort: {sortOption.label}</option>)}
                    </select>
                  </>
                )}
              >
                {sortedCarriers.length === 0 ? <div className="notice">{carriers.length === 0 ? 'No carriers found.' : 'No owned carriers found.'}</div> : (
                  <div className="card-grid card-grid-wide">
                    {sortedCarriers.map((carrier) => <CarrierCard key={carrier.carrier_id} carrier={carrier} />)}
                  </div>
                )}
              </Section>
            </>
          );
        }}
      </LoadingState>

      <CarrierHistorySection commanderFilter={commanderFilter} />
    </>
  );
}
