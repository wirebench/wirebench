import { expect, it } from 'vitest';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { Fixture, FIXTURE_VERSION, migrationDrift } from '../../fixtures/tenancy/load.js';

const atFixture = async () => (await allMigrations(BUILTIN_MODULES)).filter((m) => m.version <= FIXTURE_VERSION);

it("matches today's migrations 0001 to 0019 to the ones the fixture was generated with", async () => {
  expect(migrationDrift(await atFixture(), Fixture.migrations)).toEqual([]);
});

it('names a migration edited, renamed or missing since (Task 4 review, M5)', async () => {
  const today = await atFixture();
  const edited = today.map((m) => (m.version === 7 ? { ...m, sql: `${m.sql}\n-- edited` } : m));
  expect(migrationDrift(edited, Fixture.migrations)).toEqual(['7_licensing', '7_licensing']);
  const renamed = today.map((m) => (m.version === 2 ? { ...m, name: 'identity-v2' } : m));
  expect(migrationDrift(renamed, Fixture.migrations)).toEqual(['2_identity-v2', '2_identity']);
  expect(migrationDrift(today.slice(0, -1), Fixture.migrations)).toEqual(['19_agent-pairings']);
});
