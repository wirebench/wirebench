import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SignatureScheme } from '@wirebench/engine';
import * as repo from '../../../src/hooks/repo.js';
import { seal } from '../../../src/hooks/secret-box.js';
import { describeDb } from '../../helpers/database.js';
import { hooksRepoHarness, newCapture, seedCatchUrl } from '../../helpers/hooks.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const KEY = Buffer.alloc(32, 7);
const SECRET = 'abc123def456ghi789';
const HMAC: SignatureScheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
const STANDARD: SignatureScheme = { kind: 'standard', toleranceSec: 300 };

describeDb('webhook-signatures storage (§3.2)', () => {
  let h: IdentityHarness;
  let workspaceId: string;
  beforeEach(async () => {
    h = await hooksRepoHarness();
    const team = await seedTeam(h, { name: 'Payments QA' });
    workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  });
  afterEach(() => h.close());

  it('0005 adds the columns', async () => {
    const columns = await h.db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = current_schema()
         and column_name in ('signature', 'signature_secret', 'signature_hint', 'reject_unverified',
                             'signature_verdict', 'signature_reason', 'rejected')
       order by 1, 2`,
    );
    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      'captures.rejected',
      'captures.signature_reason',
      'captures.signature_verdict',
      'catch_urls.reject_unverified',
      'catch_urls.signature',
      'catch_urls.signature_hint',
      'catch_urls.signature_secret',
    ]);
  });

  it('stores a scheme with its sealed secret, reads back only that one is set, and clears all four', async () => {
    const hook = await seedCatchUrl(h, workspaceId, 'Payments');
    expect(hook).toMatchObject({ signature: null, secretSet: false, signatureHint: null, rejectUnverified: false });
    await repo.updateCatchUrl(h.db, hook.id, {
      signature: { scheme: HMAC, sealedSecret: seal(KEY, SECRET), hint: 'i789' },
      rejectUnverified: true,
    });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, hook.id)).toMatchObject({
      signature: HMAC,
      secretSet: true,
      signatureHint: 'i789',
      rejectUnverified: true,
    });
    const found = await repo.catchUrlBySecret(h.db, hook.secret);
    expect(found?.signature?.scheme).toEqual(HMAC);
    expect(found?.rejectUnverified).toBe(true);
    expect(await repo.countSignedCatchUrls(h.db)).toBe(1);
    expect(JSON.stringify(await repo.catchUrlsOfWorkspace(h.db, workspaceId))).not.toContain(SECRET);

    await repo.updateCatchUrl(h.db, hook.id, { signature: { scheme: STANDARD } });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, hook.id)).toMatchObject({
      signature: STANDARD,
      secretSet: true,
      signatureHint: 'i789',
    });

    await repo.updateCatchUrl(h.db, hook.id, { signature: null, rejectUnverified: false });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, hook.id)).toMatchObject({
      signature: null,
      secretSet: false,
      signatureHint: null,
      rejectUnverified: false,
    });
    expect((await repo.catchUrlBySecret(h.db, hook.secret))?.signature).toBeUndefined();
    expect(await repo.countSignedCatchUrls(h.db)).toBe(0);
  });

  it('refuses a scheme without a secret, and reject unverified without a scheme (check constraints)', async () => {
    const hook = await seedCatchUrl(h, workspaceId, 'Payments');
    await expect(
      h.db.query(`update catch_urls set signature = '{"kind":"standard","toleranceSec":300}'::jsonb where id = $1`, [
        hook.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(repo.updateCatchUrl(h.db, hook.id, { rejectUnverified: true })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('records a verdict and a rejection on a capture', async () => {
    const hook = await seedCatchUrl(h, workspaceId, 'Payments');
    const verified = newCapture(hook.id, { signature: { verdict: 'verified' } });
    const failed = newCapture(hook.id, { signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true });
    const unchecked = newCapture(hook.id);
    for (const capture of [verified, failed, unchecked]) await repo.insertCapture(h.db, capture);
    const page = await repo.listCaptures(h.db, hook.id, {}, 10);
    expect(page.map((row) => [row.id, row.signature, row.rejected])).toEqual([
      [unchecked.id, null, false],
      [failed.id, { verdict: 'failed', reason: 'mismatch' }, true],
      [verified.id, { verdict: 'verified' }, false],
    ]);
    expect(await repo.captureById(h.db, hook.id, failed.id)).toMatchObject({
      signature: { verdict: 'failed', reason: 'mismatch' },
      rejected: true,
    });
  });
});
