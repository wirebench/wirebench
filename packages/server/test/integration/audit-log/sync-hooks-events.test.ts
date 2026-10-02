import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import type { AuditInput } from '../../../src/context.js';
import { syncModule } from '../../../src/sync/module.js';
import { expectNoSecretsInAudit, recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam } from '../../helpers/teams.js';

type Harness = Awaited<ReturnType<typeof licensingHarness>>;
type User = Awaited<ReturnType<typeof signedInUser>>;

/** The key the signature suites use (`test/integration/hooks/signatures-manage.test.ts`); without it a signature is refused. */
const KEY_ENV = { WIREBENCH_SERVER_HOOKS_SECRET_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' };
const HMAC = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-sig' };

/** A value file is named by a 26-character id (`isTeamSecretsPath`). */
const VALUE_ID = 'DB'.padStart(26, '0');
const VALUE_PATH = `team-secrets/values/${VALUE_ID}.yaml`;

const last = (events: AuditInput[], action: AuditInput['action']) => events.filter((e) => e.action === action).at(-1)!;

/** One commit through `POST …/sync/commits` (engine `syncPushRequestSchema`). */
async function push(
  h: Harness,
  user: User,
  workspaceId: string,
  parent: string | null,
  changes: unknown[],
): Promise<string> {
  const res = await call<{ head: string }>(h, user, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
    parent,
    commits: [{ subject: 'push', at: h.clock.now.toISOString(), changes }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.head;
}

describeDb('sync, webhook and CI-token fire sites (audit-log spec §3.2, plan rulings 4, 6, 7)', () => {
  let h: Harness;
  let events: AuditInput[];
  let admin: User;
  let workspaceId: string;

  beforeAll(async () => {
    // licensingHarness brings identity, licensing, teams, webhook capture and CI tokens; sync and audit
    // are added, so the combined migrations run 0001 to 0008 with no gap.
    h = await licensingHarness(testKeys(), {
      env: KEY_ENV,
      extra: (clock) => [syncModule(), auditLogModule({ now: () => clock.now })],
    });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
    // Through the route, so the bare repository exists for the pushes below.
    workspaceId = (await call<{ id: string }>(h, admin, 'POST', `/teams/${team.id}/workspaces`, { name: 'W' })).body.id;
  });
  afterAll(() => h.close());

  it('a push records workspace.pushed with both heads, and secret events from its paths', async () => {
    const first = await push(h, admin, workspaceId, null, [{ path: VALUE_PATH, encoding: 'utf8', content: 'enc' }]);
    expect(last(events, 'workspace.pushed')).toMatchObject({
      target: { kind: 'workspace', id: workspaceId },
      workspaceId,
      details: { head: first, previousHead: null, commits: 1 },
    });
    expect(last(events, 'secret.shared').details).toEqual({ count: 1, ids: [VALUE_ID] });
    await push(h, admin, workspaceId, first, [{ path: VALUE_PATH, encoding: 'utf8', content: 'enc2' }]);
    expect(last(events, 'secret.rotated').details).toEqual({ count: 1, ids: [VALUE_ID] });
  });

  it('a key request records secret.access_changed with its key id and the new head', async () => {
    const keyId = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const res = await call<{ head: string }>(h, admin, 'POST', `/workspaces/${workspaceId}/team-secrets/key-requests`, {
      keyId,
      content: 'public key',
    });
    expect(res.status).toBe(201);
    expect(last(events, 'secret.access_changed')).toMatchObject({
      workspaceId,
      details: { entries: 0, keyRequests: 1, keyId, head: res.body.head },
    });
  });

  it('catch URL created, changed with a signature set then cleared, rotated, cleared, deleted', async () => {
    const base = `/workspaces/${workspaceId}/hooks`;
    const hook = (await call<{ id: string }>(h, admin, 'POST', base, { name: 'orders' })).body;
    expect(last(events, 'hook.created')).toMatchObject({
      target: { kind: 'hook', id: hook.id },
      workspaceId,
      details: { name: 'orders' },
    });

    expect(
      (await call(h, admin, 'PATCH', `${base}/${hook.id}`, { signature: { scheme: HMAC, secret: 'shh' } })).status,
    ).toBe(200);
    expect(last(events, 'hook.signature_set').details).toEqual({ scheme: 'hmac' });
    expect(JSON.stringify(events)).not.toContain('shh');

    await call(h, admin, 'PATCH', `${base}/${hook.id}`, { signature: null, name: 'orders-v2' });
    expect(last(events, 'hook.signature_cleared').details).toEqual({ scheme: 'hmac' });
    expect(last(events, 'hook.changed').details).toMatchObject({ name: 'orders-v2', previousName: 'orders' });

    await call(h, admin, 'POST', `${base}/${hook.id}/rotate`);
    expect(last(events, 'hook.rotated').details).toEqual({ name: 'orders-v2' });
    await call(h, admin, 'DELETE', `${base}/${hook.id}/captures`);
    expect(last(events, 'hook.cleared').details).toMatchObject({ name: 'orders-v2' });
    await call(h, admin, 'DELETE', `${base}/${hook.id}`);
    expect(last(events, 'hook.deleted').details).toEqual({ name: 'orders-v2' });
  });

  it('CI token created and revoked with its name; a second revoke records nothing', async () => {
    const base = `/workspaces/${workspaceId}/ci-tokens`;
    const token = (await call<{ id: string }>(h, admin, 'POST', base, { name: 'gha' })).body;
    expect(last(events, 'ci_token.created')).toMatchObject({
      target: { kind: 'ci-token', id: token.id },
      workspaceId,
      details: { name: 'gha' },
    });
    const before = events.length;
    await call(h, admin, 'DELETE', `${base}/${token.id}`);
    expect(last(events, 'ci_token.revoked').details).toEqual({ name: 'gha' });
    await call(h, admin, 'DELETE', `${base}/${token.id}`);
    expect(events.length).toBe(before + 1);
  });

  it('writes no secret-shaped value and never a pushed value', async () => {
    expect(JSON.stringify(events)).not.toContain('enc2');
    await expectNoSecretsInAudit(h.db);
  });
});
