// packages/server/test/integration/ci-tokens/repo.test.ts
import { afterEach, expect, it } from 'vitest';
import * as repo from '../../../src/ci-tokens/repo.js';
import { isUniqueViolation } from '../../../src/db/errors.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

let h: HooksHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setUp() {
  h = await hooksHarness();
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  return { h, admin, workspaceId };
}

describeDb('ci_tokens (callback-assertion §3)', () => {
  it('keeps the hash only, lists live tokens by name, revokes once, and records use', async () => {
    const { h, admin, workspaceId } = await setUp();
    const minted = mintToken();
    const id = newId();
    await repo.insertCiToken(h.db, {
      id,
      workspaceId,
      name: 'pipeline-main',
      tokenHash: minted.hash,
      createdBy: admin.user.id,
      at: h.clock.now,
    });
    const found = await repo.ciTokenByHash(h.db, minted.hash);
    expect(found).toMatchObject({
      id,
      workspaceId,
      name: 'pipeline-main',
      createdBy: admin.user.id,
      createdByName: admin.user.displayName,
      createdAt: h.clock.now.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    });
    const stored = await h.db.query<{ token_hash: string }>('select token_hash from ci_tokens');
    expect(JSON.stringify(stored.rows)).not.toContain(minted.token);

    h.clock.advance(5_000);
    await repo.touchCiToken(h.db, id, h.clock.now);
    expect((await repo.ciTokenByHash(h.db, minted.hash))?.lastUsedAt).toBe(h.clock.now.toISOString());

    expect((await repo.ciTokensOfWorkspace(h.db, workspaceId)).map((t) => t.name)).toEqual(['pipeline-main']);
    expect(await repo.revokeCiToken(h.db, workspaceId, id, h.clock.now)).toBe('pipeline-main');
    expect(await repo.revokeCiToken(h.db, workspaceId, id, h.clock.now)).toBeUndefined();
    expect(await repo.ciTokensOfWorkspace(h.db, workspaceId)).toEqual([]);
    expect((await repo.ciTokenByHash(h.db, minted.hash))?.revokedAt).toBe(h.clock.now.toISOString());
  });

  it('refuses a second live token of the same name in any case, and frees the name on revoke', async () => {
    const { h, workspaceId } = await setUp();
    const first = newId();
    await repo.insertCiToken(h.db, {
      id: first,
      workspaceId,
      name: 'Pipeline',
      tokenHash: mintToken().hash,
      createdBy: null,
      at: h.clock.now,
    });
    const again = repo.insertCiToken(h.db, {
      id: newId(),
      workspaceId,
      name: 'pipeline',
      tokenHash: mintToken().hash,
      createdBy: null,
      at: h.clock.now,
    });
    await expect(again).rejects.toSatisfy((error) => isUniqueViolation(error, 'ci_tokens_workspace_name_lower'));
    await repo.revokeCiToken(h.db, workspaceId, first, h.clock.now);
    await repo.insertCiToken(h.db, {
      id: newId(),
      workspaceId,
      name: 'pipeline',
      tokenHash: mintToken().hash,
      createdBy: null,
      at: h.clock.now,
    });
    expect((await repo.ciTokensOfWorkspace(h.db, workspaceId)).map((t) => t.name)).toEqual(['pipeline']);
  });

  it('goes with its workspace', async () => {
    const { h, workspaceId } = await setUp();
    const minted = mintToken();
    await repo.insertCiToken(h.db, {
      id: newId(),
      workspaceId,
      name: 'pipeline',
      tokenHash: minted.hash,
      createdBy: null,
      at: h.clock.now,
    });
    await teamsRepo.deleteWorkspace(h.db, workspaceId);
    expect(await repo.ciTokenByHash(h.db, minted.hash)).toBeUndefined();
  });
});
