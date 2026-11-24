/**
 * The BGS activity fields a manual adjustment can set, shared by the adjustment dialog and the
 * adjustments list. Keys match the server's fields (src/server/routes/bgs-adjustment-routes.mjs).
 */
import { CZ_OBJECTIVES } from './bgs-report.js';

/**
 * Every field that can be corrected, in groups. Keys match the server's adjustment fields.
 * isCredits fields accept "1.2M" style amounts; only allowsNegative fields may go below zero.
 */
export const ADJUSTMENT_GROUPS = [
  {
    label: 'Influence',
    fields: [
      { key: 'inf:primary', label: 'Primary INF', allowsNegative: true },
      { key: 'inf:secondary', label: 'Secondary INF', allowsNegative: true },
    ],
  },
  {
    label: 'Combat',
    fields: [
      { key: 'bounty', label: 'Bounties', isCredits: true },
      { key: 'combat_bond', label: 'Combat Bonds', isCredits: true },
      { key: 'murder', label: 'Murders' },
      { key: 'ground_murder', label: 'Ground Murders' },
      { key: 'scenario', label: 'Scenarios' },
    ],
  },
  {
    label: 'Trade',
    fields: [
      { key: 'trade_buy', label: 'Trade Buy', isCredits: true },
      { key: 'trade_profit', label: 'Trade Profit', isCredits: true, allowsNegative: true },
      { key: 'black_market', label: 'Black Market Profit', isCredits: true, allowsNegative: true },
    ],
  },
  {
    label: 'Data',
    fields: [
      { key: 'exploration', label: 'Exploration', isCredits: true },
      { key: 'organic', label: 'Exobiology', isCredits: true },
    ],
  },
  {
    label: 'Missions & Rescue',
    fields: [
      { key: 'mission_failed', label: 'Failed Missions' },
      { key: 'search_rescue', label: 'Search & Rescue' },
    ],
  },
  {
    label: 'Space Conflict Zones',
    fields: [
      { key: 'space_cz:l', label: 'Low' },
      { key: 'space_cz:m', label: 'Medium' },
      { key: 'space_cz:h', label: 'High' },
      ...CZ_OBJECTIVES.map(([objective, symbol, label]) => ({ key: `space_cz_objective:${objective}`, label: `${symbol} ${label}` })),
    ],
  },
  {
    label: 'Ground Conflict Zones',
    fields: [
      { key: 'ground_cz:l', label: 'Low' },
      { key: 'ground_cz:m', label: 'Medium' },
      { key: 'ground_cz:h', label: 'High' },
    ],
  },
];

export const ADJUSTMENT_FIELDS = Object.fromEntries(ADJUSTMENT_GROUPS.flatMap((group) => group.fields.map((field) => [
  field.key,
  { ...field, fullLabel: group.label.endsWith('Conflict Zones') ? `${group.label.replace('Conflict Zones', 'CZ')} ${field.label}` : field.label },
])));

const AMOUNT_SUFFIXES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** "1.2M", "450k", "1,234", "+3" or "-2" -> a number, or NaN if it isn't one. */
export function parseAmount(text) {
  const match = text.trim().replaceAll(',', '').match(/^([+-]?\d*\.?\d+)\s*([kmbt]?)$/i);
  if (!match) return Number.NaN;
  return Number(match[1]) * (AMOUNT_SUFFIXES[match[2].toLowerCase()] ?? 1);
}
