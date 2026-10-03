import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { call, teamsHarness } from '../../helpers/teams.js';

describeDb('0003_teams (§4.1)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('comes right after identity, and production runs it (0009 is teams-access again, after audit-log)', async () => {
    const list = (await allMigrations(BUILTIN_MODULES)).map((m) => `${m.version}_${m.name}`);
    expect(list.slice(0, 3)).toEqual(['1_init', '2_identity', '3_teams']);
    expect(list[8]).toBe('9_desktop-recording');
    expect(list[9]).toBe('10_audit-team-index');
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual([
      'identity',
      'licensing',
      'teams-access',
      'server-sync',
      'webhook-capture',
      'ci-tokens',
      'live-updates',
      'audit-log',
    ]);
  });

  it('refuses to run over a workspaces table that already has rows', async () => {
    const all = await allMigrations(BUILTIN_MODULES);
    await migrate(db, all.slice(0, 2));
    await db.query("insert into workspaces (id, name) values ('01J8ZC5Q0V7R3T9XK2M4N6P8QA', 'early')");
    await expect(migrate(db, all)).rejects.toThrow(/0003_teams needs an empty workspaces table/);
  });
});

describeDb('the teams capability (§5.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await teamsHarness();
  });
  afterEach(() => h.close());

  it('meta lists teams after identity', async () => {
    const meta = await call<{ capabilities: string[] }>(h, undefined, 'GET', '/meta');
    expect(meta.body.capabilities).toEqual(['identity', 'teams']);
  });
});
