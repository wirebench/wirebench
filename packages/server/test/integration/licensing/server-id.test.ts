import { afterEach, expect, it } from 'vitest';
import * as repo from '../../../src/licensing/repo.js';
import { describeDb } from '../../helpers/database.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
let h: IdentityHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describeDb('the server id (license-binding spec §3.1)', () => {
  it('is minted once, as one lowercase UUID row', async () => {
    h = await licensingHarness(keys);
    const rows = (await h.db.query('select server_id::text as id from server_identity')).rows;
    expect(rows).toHaveLength(1);
    expect(await repo.serverId(h.db)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('survives a restart over the same schema', async () => {
    h = await licensingHarness(keys);
    const before = await repo.serverId(h.db);
    const restarted = await licensingHarness(keys, { db: h.db });
    expect(await repo.serverId(restarted.db)).toBe(before);
    await restarted.close();
  });

  it('is an error, never a re-mint, when the row is gone', async () => {
    h = await licensingHarness(keys);
    await h.db.query('delete from server_identity');
    await expect(repo.serverId(h.db)).rejects.toThrow(repo.MISSING_SERVER_ID);
  });
});
