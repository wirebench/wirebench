/**
 * Server-sync, webhook capture and CI tokens in a tenant (tenancy plan Task 10; spec §19.8, §19.13). Until `0021`
 * there is one tenant, so the suite shows that every statement the three modules send goes through the tenant
 * database: the harness registers them with `scopedContext`, whose `ctx.db` throws, and the statement log shows
 * each one after its unit's `set_config`. A catch URL has no session: its tenant is the one its `Host` names.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SyncChange, SyncPushCommit } from '@wirebench/engine';
import type { CaptureReceivedEvent, HeadMovedEvent, HooksChangedEvent } from '../../../src/context.js';
import { ciTokensModule } from '../../../src/ci-tokens/module.js';
import { hooksModule } from '../../../src/hooks/module.js';
import { syncModule } from '../../../src/sync/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam } from '../../helpers/teams.js';
import { expectAllScoped, expectNoRawStatementsOn } from '../../helpers/tenancy.js';

const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

/** The three modules' own tables, and the workspace rows they read: none may be reached around a unit. */
const TABLES = ['catch_urls', 'captures', 'ci_tokens', 'workspaces'];

describeDb('server-sync, webhook capture and CI tokens in a tenant (tenancy Task 10)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let workspaceId: string;
  beforeEach(async () => {
    h = await identityHarness({
      modules: (clock) => [
        teamsModule({ now: () => clock.now }),
        syncModule(),
        hooksModule({ now: () => clock.now }),
        ciTokensModule({ now: () => clock.now }),
      ],
    });
    admin = await signedInUser(h, { email: 'admin@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
    workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
  });
  afterEach(() => h.close());

  it('runs every statement of every route it serves inside a unit of the request’s tenant', async () => {
    const heads: HeadMovedEvent[] = [];
    const captures: CaptureReceivedEvent[] = [];
    const changed: HooksChangedEvent[] = [];
    h.hooks.headMoved.push((event) => heads.push(event));
    h.hooks.captureReceived.push((event) => captures.push(event));
    h.hooks.hooksChanged.push((event) => changed.push(event));
    h.statements.entries.length = 0;
    const ok = async <T>(status: number, request: Promise<{ readonly status: number; readonly body: T }>) => {
      const res = await request;
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      return res.body;
    };
    const ws = `/workspaces/${workspaceId}`;

    // Sync: a push, then every read.
    const pushed = await ok<{ head: string }>(
      201,
      call(h, admin, 'POST', `${ws}/sync/commits`, {
        parent: null,
        commits: [commit('One', [text('workspace.yaml', 'a\n')])],
      }),
    );
    await ok(200, call(h, admin, 'GET', `${ws}/sync/head`));
    await ok(200, call(h, admin, 'GET', `${ws}/sync/snapshot?at=${pushed.head}`));
    await ok(200, call(h, admin, 'GET', `${ws}/sync/log`));

    // A catch URL, a capture through its public route, and the capture API.
    const hook = await ok<{ id: string; url: string }>(
      201,
      call(h, admin, 'POST', `${ws}/hooks`, { name: 'Payments' }),
    );
    await ok(200, call(h, admin, 'GET', `${ws}/hooks`));
    await ok(200, call(h, admin, 'PATCH', `${ws}/hooks/${hook.id}`, { name: 'Payments API' }));
    const received = await h.app.inject({
      method: 'POST',
      url: new URL(hook.url).pathname,
      headers: { 'content-type': 'application/json' },
      payload: '{"id":"evt_1"}',
    });
    expect(received.statusCode).toBe(200);
    const listed = await ok<{ id: string }[]>(200, call(h, admin, 'GET', `${ws}/hooks/${hook.id}/captures`));
    await ok(200, call(h, admin, 'GET', `${ws}/hooks/${hook.id}/captures/${listed[0]!.id}`));

    // A CI token: made, used, listed and revoked.
    const ci = await ok<{ id: string; token: string }>(201, call(h, admin, 'POST', `${ws}/ci-tokens`, { name: 'CI' }));
    const asCi = (path: string) =>
      h.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${ci.token}` } });
    expect((await asCi('/ci/whoami')).statusCode).toBe(200);
    expect((await asCi(`${ws}/hooks/${hook.id}/captures`)).statusCode).toBe(200);
    await ok(200, call(h, admin, 'GET', `${ws}/ci-tokens`));
    await ok(204, call(h, admin, 'DELETE', `${ws}/ci-tokens/${ci.id}`));
    await ok(204, call(h, admin, 'DELETE', `${ws}/hooks/${hook.id}/captures`));
    await ok(204, call(h, admin, 'DELETE', `${ws}/hooks/${hook.id}`));

    expectAllScoped(h.statements, h.tdb.scope.tenantId);
    expectNoRawStatementsOn(h.ctx, TABLES);
    // Every announcement carries the tenant (spec §19.8 guard 5).
    const tenantId = h.tdb.scope.tenantId;
    expect(heads.map((event) => event.tenantId)).toEqual([tenantId]);
    expect(captures.map((event) => event.tenantId)).toEqual([tenantId]);
    expect(changed.length).toBeGreaterThan(0);
    for (const event of changed) expect(event.tenantId).toBe(tenantId);
  });

  it('writes a push’s workspace.pushed and its secret events in one transaction (Task 10 review M3)', async () => {
    // Each audit row reports the transaction it is written in, as the audit module's insert would run in it.
    const written: { readonly action: string; readonly txid: string }[] = [];
    h.hooks.audit.push(async (tx, event) => {
      const row = (await tx.query<{ txid: string }>('select txid_current()::text as txid')).rows[0]!;
      written.push({ action: event.action, txid: row.txid });
    });
    const valuePath = `team-secrets/values/${'DB'.padStart(26, '0')}.yaml`;
    const pushed = await call(h, admin, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
      parent: null,
      commits: [commit('Share a value', [text(valuePath, 'enc')])],
    });
    expect(pushed.status).toBe(201);
    expect(written.map((row) => row.action)).toEqual(['workspace.pushed', 'secret.shared']);
    expect(new Set(written.map((row) => row.txid)).size).toBe(1);
  });

  it('looks a CI token up and touches it in one unit', async () => {
    const ci = (await call<{ token: string }>(h, admin, 'POST', `/workspaces/${workspaceId}/ci-tokens`, { name: 'CI' }))
      .body;
    h.statements.entries.length = 0;
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/ci/whoami',
      headers: { authorization: `Bearer ${ci.token}` },
    });
    expect(res.statusCode).toBe(200);
    const ciStatements = h.statements.entries.filter(
      (entry) => entry.kind === 'statement' && entry.text.includes('ci_tokens'),
    );
    expect(ciStatements.map((entry) => entry.text)).toEqual([
      expect.stringContaining('where t.token_hash = $1'),
      expect.stringContaining('update ci_tokens set last_used_at'),
    ]);
    expect(new Set(ciStatements.map((entry) => entry.unit)).size).toBe(1);
  });
});
