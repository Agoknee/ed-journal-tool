import { useState } from 'react';
import DataTable from '../../components/DataTable.jsx';
import { ComponentTypeIcon, MaterialGradeIcon } from '../../components/inara-icons.jsx';
import { Badge, LoadingState, Section, StatCard, StatGrid, Tabs } from '../../components/ui.jsx';
import { useApi } from '../../hooks/use-api.js';
import { formatCredits, formatDateTime, formatNumber } from '../../format.js';

const INVENTORY_TABS = [
  { id: 'materials', label: 'Materials' },
  { id: 'locker', label: 'Ship locker' },
  { id: 'backpack', label: 'Backpack' },
  { id: 'cargo', label: 'Cargo' },
  { id: 'suits', label: 'Suits & weapons' },
];
const MATERIAL_CATEGORIES = [
  { key: 'raw', label: 'Raw' },
  { key: 'manufactured', label: 'Manufactured' },
  { key: 'encoded', label: 'Encoded' },
];
const ON_FOOT_CATEGORIES = [
  { key: 'items', label: 'Goods' },
  { key: 'components', label: 'Assets' },
  { key: 'data', label: 'Data' },
  { key: 'consumables', label: 'Consumables' },
];

/** Materials, on-foot items (ship locker and backpack), cargo, and suits and weapons. */
export default function InventorySection({ commanderId, picker }) {
  const [activeTab, setActiveTab] = useState('materials');
  const assetsRequest = useApi(commanderId ? '/api/stats/inventory' : null, { commander: commanderId });
  const fleetRequest = useApi(commanderId ? '/api/stats/fleet' : null, { commander: commanderId });

  return (
    <Section
      id="commanders-inventory"
      title="Inventory"
      description="Engineering materials, on-foot items, cargo, and suits and weapons."
      actions={picker}
    >
      <LoadingState requestState={assetsRequest}>
        {(assets) => {
          const countItems = (items) => (items ?? []).reduce((total, item) => total + (item.count ?? 0), 0);
          const materialCount = MATERIAL_CATEGORIES.reduce((total, category) => total + countItems(assets.materials?.[category.key]), 0);
          const lockerCount = ON_FOOT_CATEGORIES.reduce((total, category) => total + countItems(assets.shipLocker?.[category.key]), 0);
          const ownedSuits = fleetRequest.data?.suits.filter((suit) => !suit.isSold) ?? [];
          const currentCargoCapacity = fleetRequest.data?.ships.find((ship) => ship.isCurrent)?.cargoCapacity ?? null;
          const ownedWeapons = fleetRequest.data?.weapons.filter((weapon) => !weapon.isSold) ?? [];
          return (
            <>
              <StatGrid>
                <StatCard label="Materials" value={formatNumber(materialCount)} detail={`${formatNumber(MATERIAL_CATEGORIES.reduce((total, category) => total + (assets.materials?.[category.key]?.length ?? 0), 0))} kinds`} />
                <StatCard label="Ship locker" value={formatNumber(lockerCount)} detail="on-foot items" />
                <StatCard label="Cargo" value={`${formatNumber(assets.cargo?.count ?? 0)} t`} detail={currentCargoCapacity ? `of ${formatNumber(currentCargoCapacity)} t` : null} />
                <StatCard label="Suits" value={formatNumber(ownedSuits.length)} />
                <StatCard label="Weapons" value={formatNumber(ownedWeapons.length)} />
              </StatGrid>
              <Tabs tabs={INVENTORY_TABS} activeTab={activeTab} onChange={setActiveTab} />
              <div className="tab-panel">
                {activeTab === 'materials' && <MaterialsTab materials={assets.materials} updatedAt={assets.updatedAt.materials} />}
                {activeTab === 'locker' && <OnFootTab tableId="commanders.shipLocker" inventory={assets.shipLocker} updatedAt={assets.updatedAt.shipLocker} pageSize={10} isSearchable />}
                {activeTab === 'backpack' && <OnFootTab tableId="commanders.backpack" inventory={assets.backpack} updatedAt={assets.updatedAt.backpack} pageSize={10} isSearchable />}
                {activeTab === 'cargo' && <CargoTab cargo={assets.cargo} updatedAt={assets.updatedAt.cargo} />}
                {activeTab === 'suits' && <SuitsTab fleetRequest={fleetRequest} />}
              </div>
            </>
          );
        }}
      </LoadingState>
    </Section>
  );
}

function Snapshot({ updatedAt, note }) {
  return updatedAt ? <p className="muted small">As of {formatDateTime(updatedAt)}{note ? ` · ${note}` : ''}</p> : null;
}

function MaterialsTab({ materials, updatedAt }) {
  const [categoryKey, setCategoryKey] = useState('raw');
  const [search, setSearch] = useState('');
  if (!materials) return <div className="notice">No materials recorded yet; they’re listed when you log in.</div>;

  // A search looks through every category; otherwise the chosen category is shown.
  const normalizedSearch = search.trim().toLowerCase();
  const isSearching = normalizedSearch !== '';
  const shownCategories = isSearching ? MATERIAL_CATEGORIES : MATERIAL_CATEGORIES.filter((category) => category.key === categoryKey);
  const items = shownCategories
    .flatMap((category) => (materials[category.key] ?? []).map((material) => ({ ...material, categoryLabel: category.label })))
    .filter((material) => !isSearching || material.name.toLowerCase().includes(normalizedSearch) || material.family?.toLowerCase().includes(normalizedSearch));
  // Families in a fixed order (graded families first), each listed grade 1 to 5. Guardian and
  // Thargoid families exist in two categories, so groups are per category and family.
  const isSpecialFamily = (family) => ['Guardian', 'Thargoid', 'Other'].includes(family);
  const groups = [...new Map(items.map((material) => [`${material.categoryLabel}:${material.family}`, material])).values()]
    .map((material) => ({ key: `${material.categoryLabel}:${material.family}`, family: material.family, categoryLabel: material.categoryLabel }))
    .sort((first, second) => Number(isSpecialFamily(first.family)) - Number(isSpecialFamily(second.family))
      || MATERIAL_CATEGORIES.findIndex((category) => category.label === first.categoryLabel) - MATERIAL_CATEGORIES.findIndex((category) => category.label === second.categoryLabel)
      || first.family.localeCompare(second.family, undefined, { numeric: true }))
    .map((group) => ({
      ...group,
      materials: items
        .filter((material) => material.family === group.family && material.categoryLabel === group.categoryLabel)
        .sort((first, second) => (first.grade ?? 9) - (second.grade ?? 9) || first.name.localeCompare(second.name)),
    }));
  const all = materials[categoryKey] ?? [];
  const atCap = all.filter((material) => material.maxCount && material.count >= material.maxCount).length;
  const categoryTabs = MATERIAL_CATEGORIES.map((category) => ({
    id: category.key,
    label: `${category.label} (${formatNumber((materials[category.key] ?? []).reduce((total, material) => total + material.count, 0))})`,
  }));
  const chooseCategory = (nextCategoryKey) => {
    setCategoryKey(nextCategoryKey);
    setSearch('');
  };

  return (
    <>
      <Snapshot updatedAt={updatedAt} note="the full list comes at login; changes since are applied as they happen" />
      <div className="section-toolbar">
        <Tabs tabs={categoryTabs} activeTab={isSearching ? null : categoryKey} onChange={chooseCategory} />
        <input type="search" className="toolbar-search" placeholder="Search all materials or families…" value={search} onChange={(changeEvent) => setSearch(changeEvent.target.value)} />
      </div>
      <p className="muted small">
        {isSearching
          ? `${formatNumber(items.length)} ${items.length === 1 ? 'match' : 'matches'} across all categories.`
          : `${formatNumber(all.length)} kinds · ${formatNumber(atCap)} at their storage cap.`}
        {' '}Caps by grade: 300, 250, 200, 150, 100.
      </p>
      <div className="material-families">
        {groups.map(({ key, family, categoryLabel, materials: familyMaterials }) => (
          <div key={key} className="material-family">
            <h4>{family}{isSearching || isSpecialFamily(family) ? <span className="material-family-category"> · {categoryLabel}</span> : null}</h4>
            <ul>
              {familyMaterials.map((material) => <MaterialRow key={material.key} material={material} />)}
            </ul>
          </div>
        ))}
      </div>
      {groups.length === 0 && <div className="notice">No matching materials.</div>}
    </>
  );
}

function MaterialRow({ material }) {
  const ratio = material.maxCount ? Math.min(1, material.count / material.maxCount) : null;
  const isFull = ratio === 1;
  return (
    <li className="material-row" title={material.maxCount ? `${material.count} of ${material.maxCount}` : `${material.count}`}>
      <span className="material-grade"><MaterialGradeIcon grade={material.grade} /></span>
      <span className="material-name">{material.name}</span>
      <span className={`material-count ${isFull ? 'material-count-full' : ''}`}>
        {formatNumber(material.count)}{material.maxCount ? <span className="muted">/{material.maxCount}</span> : null}
      </span>
      {ratio !== null && (
        <span className="material-bar"><span className={`material-bar-fill ${isFull ? 'material-bar-full' : ''}`} style={{ width: `${ratio * 100}%` }} /></span>
      )}
    </li>
  );
}

function OnFootTab({ tableId, inventory, updatedAt, pageSize = 25, isSearchable = false }) {
  const [search, setSearch] = useState('');
  if (!inventory) return <div className="notice">Nothing recorded yet.</div>;
  const normalizedSearch = search.trim().toLowerCase();
  const allRows = ON_FOOT_CATEGORIES.flatMap((category) => (inventory[category.key] ?? [])
    .map((item, index) => ({ ...item, category: category.label, rowKey: `${category.key}-${index}` })));
  const rows = normalizedSearch
    ? allRows.filter((item) => item.name.toLowerCase().includes(normalizedSearch) || item.category.toLowerCase().includes(normalizedSearch))
    : allRows;
  return (
    <>
      {isSearchable ? (
        <div className="section-toolbar on-foot-toolbar">
          <Snapshot updatedAt={updatedAt} />
          <input type="search" className="toolbar-search" placeholder="Search items or categories…" value={search} onChange={(changeEvent) => setSearch(changeEvent.target.value)} />
        </div>
      ) : <Snapshot updatedAt={updatedAt} />}
      <DataTable
        tableId={tableId}
        rowKey="rowKey"
        rows={rows}
        pageSize={pageSize}
        pageResetKey={normalizedSearch}
        emptyMessage={normalizedSearch && allRows.length ? 'No matching items.' : 'Empty.'}
        columns={[
          { key: 'category', label: 'Category' },
          {
            key: 'name',
            label: 'Item',
            render: (item) => (
              <span className="item-with-icon">
                {item.category === 'Assets' && <ComponentTypeIcon name={item.name} />}
                {item.name}
              </span>
            ),
          },
          { key: 'count', label: 'Count', align: 'right' },
        ]}
      />
    </>
  );
}

function CargoTab({ cargo, updatedAt }) {
  return (
    <>
      <Snapshot updatedAt={updatedAt} />
      <DataTable
        tableId="commanders.cargo"
        rowKey="rowKey"
        rows={(cargo?.inventory ?? []).map((item, index) => ({ ...item, rowKey: index }))}
        emptyMessage="The hold is empty."
        columns={[
          { key: 'name', label: 'Commodity' },
          { key: 'count', label: 'Tonnes', align: 'right' },
          { key: 'stolen', label: 'Stolen', align: 'right', render: (item) => (item.stolen ? <Badge tone="danger">{item.stolen}</Badge> : '—') },
          { key: 'missionId', label: 'Mission cargo', render: (item) => (item.missionId ? 'Yes' : '—') },
        ]}
      />
    </>
  );
}

function SuitsTab({ fleetRequest }) {
  return (
    <LoadingState requestState={fleetRequest}>
      {({ suits, weapons, suitLoadouts, ownedCounts }) => {
        const ownedSuits = suits.filter((suit) => !suit.isSold);
        const ownedWeapons = weapons.filter((weapon) => !weapon.isSold);
        const isIncomplete = (ownedCounts?.suits ?? 0) > ownedSuits.length || (ownedCounts?.weapons ?? 0) > ownedWeapons.length;
        return (
          <>
            {isIncomplete && (
              <p className="muted small">
                The game says you own {formatNumber(ownedCounts.suits)} suits and {formatNumber(ownedCounts.weapons)} weapons. The journal has no full list, so
                these are the ones bought, sold or used in a loadout since your journals began.
              </p>
            )}
            <h3 className="subheading">Loadouts</h3>
            <DataTable
              tableId="commanders.suitLoadouts"
              rowKey="loadoutId"
              rows={suitLoadouts}
              emptyMessage="No suit loadouts recorded."
              columns={[
                { key: 'name', label: 'Loadout' },
                { key: 'suit', label: 'Suit', sortValue: (loadout) => loadout.suit?.name ?? '', render: (loadout) => (loadout.suit ? `${loadout.suit.name} G${loadout.suit.class}` : '—') },
                {
                  key: 'weapons',
                  label: 'Weapons',
                  wrap: true,
                  sortValue: (loadout) => loadout.weapons.length,
                  render: (loadout) => loadout.weapons.map((slot) => `${slot.slot}: ${slot.weapon ? `${slot.weapon.name} G${slot.weapon.class}` : '—'}`).join(' · ') || '—',
                },
              ]}
            />
            <div className="two-column">
              <section>
                <h3 className="subheading">Suits</h3>
                <DataTable
                  tableId="commanders.suits"
                  rowKey="suitId"
                  rows={ownedSuits}
                  emptyMessage="No suits recorded."
                  columns={[
                    { key: 'name', label: 'Suit' },
                    { key: 'class', label: 'Grade', align: 'right', render: (suit) => `G${suit.class}` },
                    { key: 'mods', label: 'Modifications', wrap: true, sortValue: (suit) => suit.mods.length, render: (suit) => suit.mods.join(', ') || '—' },
                    { key: 'price', label: 'Paid', align: 'right', render: (suit) => (suit.price ? formatCredits(suit.price) : '—') },
                  ]}
                />
              </section>
              <section>
                <h3 className="subheading">Weapons</h3>
                <DataTable
                  tableId="commanders.weapons"
                  rowKey="weaponId"
                  rows={ownedWeapons}
                  emptyMessage="No weapons recorded."
                  columns={[
                    { key: 'name', label: 'Weapon' },
                    { key: 'class', label: 'Grade', align: 'right', render: (weapon) => `G${weapon.class}` },
                    { key: 'mods', label: 'Modifications', wrap: true, sortValue: (weapon) => weapon.mods.length, render: (weapon) => weapon.mods.join(', ') || '—' },
                    { key: 'price', label: 'Paid', align: 'right', render: (weapon) => (weapon.price ? formatCredits(weapon.price) : '—') },
                  ]}
                />
              </section>
            </div>
          </>
        );
      }}
    </LoadingState>
  );
}

