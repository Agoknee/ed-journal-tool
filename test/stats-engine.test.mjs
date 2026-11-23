import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/database/database.mjs';
import { statModules } from '../src/stats/index.mjs';
import { StatsEngine } from '../src/stats/stats-engine.mjs';

test('stats updates name the changed modules and every module that reads from them', () => {
  const engine = new StatsEngine({ database: openDatabase(':memory:'), statModules, eventHub: { publish() {} } });
  assert.deepEqual(new Set(engine.withDependentModules(['fleet'])), new Set(['fleet', 'engineers', 'commanders', 'carriers', 'fuel-deposits']));
  assert.deepEqual(engine.withDependentModules(['chat']), ['chat']);
});

test('every module a stat module depends on exists', () => {
  const positions = new Map(statModules.map((statModule, index) => [statModule.name, index]));
  for (const statModule of statModules) {
    for (const dependencyName of statModule.dependsOn) {
      assert.ok(positions.has(dependencyName), `${statModule.name} depends on missing ${dependencyName}`);
    }
  }
});
