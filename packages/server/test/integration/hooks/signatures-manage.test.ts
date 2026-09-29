import { afterEach, expect, it, vi } from 'vitest';
import type { CatchUrl } from '@wirebench/engine';
import { warnUnopenableSignatures } from '../../../src/hooks/module.js';
import { open } from '../../../src/hooks/secret-box.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

const KEY_ENV = { WIREBENCH_SERVER_HOOKS_SECRET_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' };
const SECRET = 'abc123def456ghi789';
const HMAC = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };

interface Cast {
  readonly h: HooksHarness;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly workspaceId: string;
  readonly hook: CatchUrl;
}

async function setUp(env: Record<string, string> = {}): Promise<Cast> {
  const h = await hooksHarness({ env });
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  const hook = (await call<CatchUrl>(h, editor, 'POST', `/workspaces/${workspaceId}/hooks`, { name: 'Signed' })).body;
  return { h, editor, viewer, workspaceId, hook };
}

const patch = (c: Cast, as: SignedInUser, body: object) =>
  call<CatchUrl & { code?: string }>(c.h, as, 'PATCH', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}`, body);
const list = (c: Cast, as: SignedInUser) => call<CatchUrl[]>(c.h, as, 'GET', `/workspaces/${c.workspaceId}/hooks`);
const sealedOf = async (c: Cast): Promise<Buffer | null> =>
  (await c.h.db.query<{ s: Buffer | null }>('select signature_secret as s from catch_urls where id = $1', [c.hook.id]))
    .rows[0]?.s ?? null;

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

describeDb('the management API: signatures (§3.4, §6)', () => {
  it('answers 409 while the key is unset, says so on reads, and still clears', async () => {
    c = await setUp();
    const refused = await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET } });
    expect([refused.status, refused.body.code]).toEqual([409, 'hooks-signature-key-unset']);
    expect((await list(c, c.editor)).body[0]).toMatchObject({
      signature: null,
      rejectUnverified: false,
      signatureAvailable: false,
    });
    expect((await patch(c, c.editor, { signature: null })).status).toBe(200);
  });

  it('sets a scheme and a write-only secret, sealed at rest; viewers see no hint', async () => {
    c = await setUp(KEY_ENV);
    const set = await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET }, rejectUnverified: true });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      signature: { scheme: HMAC, secret: { set: true, hint: 'i789' } },
      rejectUnverified: true,
      signatureAvailable: true,
    });
    expect(JSON.stringify(set.body)).not.toContain(SECRET);
    const sealed = await sealedOf(c);
    expect(sealed?.includes(Buffer.from(SECRET))).toBe(false);
    expect(open(Buffer.alloc(32, 7), sealed!)).toBe(SECRET);
    expect((await list(c, c.viewer)).body[0]?.signature).toEqual({ scheme: HMAC, secret: { set: true, hint: null } });
  });

  it('changes the scheme alone and keeps the stored secret', async () => {
    c = await setUp(KEY_ENV);
    await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET } });
    const before = await sealedOf(c);
    const changed = await patch(c, c.editor, { signature: { scheme: { kind: 'standard' } } });
    expect(changed.body.signature).toEqual({
      scheme: { kind: 'standard', toleranceSec: 300 },
      secret: { set: true, hint: 'i789' },
    });
    expect((await sealedOf(c))?.equals(before!)).toBe(true);
  });

  it('answers 400 for a scheme with no stored secret, reject unverified without a scheme, and a bad secret', async () => {
    c = await setUp(KEY_ENV);
    const noSecret = await patch(c, c.editor, { signature: { scheme: HMAC } });
    expect([noSecret.status, noSecret.body.code]).toEqual([400, 'hooks-signature-secret-required']);
    const reject = await patch(c, c.editor, { rejectUnverified: true });
    expect([reject.status, reject.body.code]).toEqual([400, 'invalid-request']);
    const both = await patch(c, c.editor, { signature: null, rejectUnverified: true });
    expect([both.status, both.body.code]).toEqual([400, 'invalid-request']);
    for (const secret of ['', 'x'.repeat(513)]) {
      const bad = await patch(c, c.editor, { signature: { scheme: HMAC, secret } });
      expect([bad.status, bad.body.code]).toEqual([400, 'invalid-request']);
    }
    const header = await patch(c, c.editor, { signature: { scheme: { ...HMAC, header: 'X Sig' }, secret: SECRET } });
    expect(header.status).toBe(400);
  });

  it('clears the scheme, the secret, the hint and reject unverified', async () => {
    c = await setUp(KEY_ENV);
    await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET }, rejectUnverified: true });
    const cleared = await patch(c, c.editor, { signature: null });
    expect(cleared.body).toMatchObject({ signature: null, rejectUnverified: false });
    expect(await sealedOf(c)).toBeNull();
  });

  it('lets only editors change it', async () => {
    c = await setUp(KEY_ENV);
    const refused = await patch(c, c.viewer, { signature: { scheme: HMAC, secret: SECRET } });
    expect([refused.status, refused.body.code]).toEqual([403, 'teams-forbidden']);
  });

  it('warns once at start-up when signed catch URLs exist and the key is unset', async () => {
    c = await setUp(KEY_ENV);
    await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET } });
    const warn = vi.fn();
    await warnUnopenableSignatures(c.h.db, { enabled: true }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    warn.mockClear();
    await warnUnopenableSignatures(c.h.db, { enabled: true, secretKey: Buffer.alloc(32, 7) }, { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
