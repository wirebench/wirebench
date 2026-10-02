import { afterEach, beforeEach, expect, it } from 'vitest';
import { CATCH_URL_DEFAULT_RESPONSE } from '@wirebench/engine';
import { isForeignKeyViolation, isUniqueViolation } from '../../../src/db/errors.js';
import { hooksModule } from '../../../src/hooks/module.js';
import * as repo from '../../../src/hooks/repo.js';
import { identityModule } from '../../../src/identity/module.js';
import { newId } from '../../../src/identity/tokens.js';
import { allMigrations } from '../../../src/serve.js';
import { syncModule } from '../../../src/sync/module.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { teamsModule } from '../../../src/teams/module.js';
import { describeDb } from '../../helpers/database.js';
import { hooksRepoHarness, newCapture, seedCatchUrl } from '../../helpers/hooks.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

describeDb('webhook-capture repository (§3.2, §3.4)', () => {
  let h: IdentityHarness;
  let workspaceId: string;
  beforeEach(async () => {
    h = await hooksRepoHarness();
    const team = await seedTeam(h, { name: 'Payments QA' });
    workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  });
  afterEach(() => h.close());

  it('0004 and 0005 follow teams-access across modules, and production runs them before live-updates', async () => {
    const list = (await allMigrations([identityModule(), teamsModule(), syncModule(), hooksModule()])).map(
      (m) => `${m.version}_${m.name}`,
    );
    expect(list).toEqual(['1_init', '2_identity', '3_teams', '4_webhook-capture', '5_webhook-signatures']);
    const { BUILTIN_MODULES } = await import('../../../src/modules.js');
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual([
      'identity',
      'licensing',
      'teams-access',
      'server-sync',
      'webhook-capture',
      'ci-tokens',
      'live-updates',
    ]);
  });

  it('inserts and lists catch URLs with their capture count and newest capture id', async () => {
    const payments = await seedCatchUrl(h, workspaceId, 'Payments');
    const source = await seedCatchUrl(h, workspaceId, 'source host', { enabled: false });
    expect(payments).toMatchObject({
      workspaceId,
      name: 'Payments',
      enabled: true,
      response: CATCH_URL_DEFAULT_RESPONSE,
      createdBy: null,
      createdAt: '2026-09-24T12:00:00.000Z',
    });
    const first = newCapture(payments.id);
    const second = newCapture(payments.id);
    await repo.insertCapture(h.db, first);
    await repo.insertCapture(h.db, second);
    const listed = await repo.catchUrlsOfWorkspace(h.db, workspaceId);
    expect(listed.map((row) => [row.name, row.captureCount, row.newestCaptureId])).toEqual([
      ['Payments', 2, second.id],
      ['source host', 0, null],
    ]);
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, source.id)).toMatchObject({ enabled: false });
    expect(await repo.catchUrlInWorkspace(h.db, newId(), source.id)).toBeUndefined();
    expect(await repo.countCatchUrls(h.db, workspaceId)).toBe(2);
    expect(await repo.catchUrlBySecret(h.db, payments.secret)).toEqual({
      id: payments.id,
      workspaceId,
      enabled: true,
      response: CATCH_URL_DEFAULT_RESPONSE,
      rejectUnverified: false,
    });
    expect(await repo.catchUrlBySecret(h.db, 'X'.repeat(26))).toBeUndefined();
  });

  it('names are unique per workspace regardless of case, under the index the routes map', async () => {
    await seedCatchUrl(h, workspaceId, 'Payments');
    let caught: unknown;
    try {
      await seedCatchUrl(h, workspaceId, 'PAYMENTS');
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, repo.CATCH_URL_NAME_INDEX)).toBe(true);
    const team = await seedTeam(h, { name: 'Other' });
    const other = await seedWorkspace(h, { team, name: 'Other' });
    await expect(seedCatchUrl(h, other, 'Payments')).resolves.toMatchObject({ name: 'Payments' });
  });

  it('updates only the fields a patch names; null clears a content type and a body', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments', {
      response: { status: 202, contentType: 'text/plain', body: 'ok', delayMs: 10 },
    });
    await repo.updateCatchUrl(h.db, row.id, { name: 'Renamed', response: { status: 204 } });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, row.id)).toMatchObject({
      name: 'Renamed',
      enabled: true,
      response: { status: 204, contentType: 'text/plain', body: 'ok', delayMs: 10 },
    });
    await repo.updateCatchUrl(h.db, row.id, { enabled: false, response: { contentType: null, body: null } });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, row.id)).toMatchObject({
      enabled: false,
      response: { status: 204, contentType: null, body: null, delayMs: 10 },
    });
    await repo.updateCatchUrl(h.db, row.id, {});
    expect((await repo.catchUrlInWorkspace(h.db, workspaceId, row.id))?.name).toBe('Renamed');
  });

  it('rotates the secret, so the old one finds nothing', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    await repo.rotateSecret(h.db, row.id, 'Z'.repeat(26));
    expect(await repo.catchUrlBySecret(h.db, row.secret)).toBeUndefined();
    expect((await repo.catchUrlBySecret(h.db, 'Z'.repeat(26)))?.id).toBe(row.id);
  });

  it('keeps headers as ordered pairs with repeats, and the body bytes exactly', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const body = Buffer.from([0, 1, 2, 0xfe, 0xff]);
    const capture = newCapture(row.id, {
      method: 'PUT',
      subpath: '/a%20b',
      query: 'x=1&x=2',
      headers: [
        ['Via', '1.1 a'],
        ['Set-Cookie', 'a=1'],
        ['Via', '1.1 b'],
      ],
      body,
      bodySize: 9,
      truncated: true,
    });
    await repo.insertCapture(h.db, capture);
    expect(await repo.captureById(h.db, row.id, capture.id)).toEqual({
      id: capture.id,
      receivedAt: '2026-09-28T10:00:00.000Z',
      method: 'PUT',
      subpath: '/a%20b',
      query: 'x=1&x=2',
      headers: [
        ['Via', '1.1 a'],
        ['Set-Cookie', 'a=1'],
        ['Via', '1.1 b'],
      ],
      body,
      bodySize: 9,
      truncated: true,
      sourceIp: '203.0.113.9',
      signature: null,
      rejected: false,
    });
    expect(await repo.captureById(h.db, newId(), capture.id)).toBeUndefined();
  });

  it('prunes to the newest `keep` in one statement: nothing at keep, the oldest at keep + 1', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const captures = Array.from({ length: 4 }, () => newCapture(row.id));
    for (const capture of captures.slice(0, 3)) await repo.insertCapture(h.db, capture);
    expect(await repo.pruneCaptures(h.db, row.id, 3)).toBe(0);
    await repo.insertCapture(h.db, captures[3]!);
    expect(await repo.pruneCaptures(h.db, row.id, 3)).toBe(1);
    const left = await repo.listCaptures(h.db, row.id, {}, 10);
    expect(left.map((capture) => capture.id)).toEqual(
      captures
        .slice(1)
        .map((c) => c.id)
        .reverse(),
    );
  });

  it('pages newest first: before goes back, after returns the ones right after an id', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const capture = newCapture(row.id);
      ids.push(capture.id);
      await repo.insertCapture(h.db, capture);
    }
    const [c0, c1, c2, c3, c4] = ids as [string, string, string, string, string];
    const idsOf = (rows: readonly repo.CaptureSummaryRow[]): string[] => rows.map((r) => r.id);
    expect(idsOf(await repo.listCaptures(h.db, row.id, {}, 2))).toEqual([c4, c3]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { before: c3 }, 2))).toEqual([c2, c1]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { after: c0 }, 2))).toEqual([c2, c1]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { after: c2 }, 5))).toEqual([c4, c3]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { after: c4 }, 5))).toEqual([]);
  });

  it('deletes captures older than a cutoff, strictly, in batches no larger than asked', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const cutoff = new Date('2026-09-21T10:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await repo.insertCapture(h.db, newCapture(row.id, { receivedAt: new Date(cutoff.getTime() - 1 - i) }));
    }
    const atCutoff = newCapture(row.id, { receivedAt: cutoff });
    await repo.insertCapture(h.db, atCutoff);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(2);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(2);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(1);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(0);
    expect((await repo.listCaptures(h.db, row.id, {}, 10)).map((c) => c.id)).toEqual([atCutoff.id]);
  });

  it('clears, and cascades from the catch URL and from the workspace', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    await repo.insertCapture(h.db, newCapture(row.id));
    await repo.insertCapture(h.db, newCapture(row.id));
    expect(await repo.clearCaptures(h.db, row.id)).toBe(2);
    await repo.insertCapture(h.db, newCapture(row.id));
    expect(await repo.deleteCatchUrl(h.db, row.id)).toBe(true);
    expect(await repo.deleteCatchUrl(h.db, row.id)).toBe(false);
    expect((await h.db.query('select count(*)::int as n from captures')).rows[0]).toEqual({ n: 0 });
    const kept = await seedCatchUrl(h, workspaceId, 'Kept');
    await repo.insertCapture(h.db, newCapture(kept.id));
    await teamsRepo.deleteWorkspace(h.db, workspaceId);
    expect(await repo.catchUrlsOfWorkspace(h.db, workspaceId)).toEqual([]);
    expect((await h.db.query('select count(*)::int as n from captures')).rows[0]).toEqual({ n: 0 });
  });

  it('names the foreign keys a racing delete trips, and locks only an existing workspace', async () => {
    let caught: unknown;
    try {
      await repo.insertCapture(h.db, newCapture(newId()));
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught, repo.CAPTURE_CATCH_URL_FK)).toBe(true);
    caught = undefined;
    try {
      await seedCatchUrl(h, newId(), 'Orphan');
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught, repo.CATCH_URL_WORKSPACE_FK)).toBe(true);
    await h.db.transaction(async (tx) => {
      expect(await repo.lockWorkspace(tx, workspaceId)).toBe(true);
      expect(await repo.lockWorkspace(tx, newId())).toBe(false);
    });
  });
});
