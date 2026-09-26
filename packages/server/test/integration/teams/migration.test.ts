import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { identityModule } from '../../../src/identity/module.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { teamsModule } from '../../../src/teams/module.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { call, teamsHarness } from '../../helpers/teams.js';

describeDb('0003_teams (§4.1)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('comes right after identity, and production runs it', async () => {
    const list = (await allMigrations([identityModule(), teamsModule()])).map((m) => `${m.version}_${m.name}`);
    expect(list).toEqual(['1_init', '2_identity', '3_teams']);
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access', 'server-sync', 'live-updates']);
  });

  it('refuses to run over a workspaces table that already has rows', async () => {
    const all = await allMigrations([identityModule(), teamsModule()]);
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
