/**
 * A server host's secrets (hosted edition spec §17.4, §19.7, plan Task 23): sealed under the user key derived from
 * the tenant's data key, never straight from the root; slice 2's blobs still open in the default tenant until the
 * re-wrap; a data key the root no longer opens closes the socket `4503` with a coded log line; and the secret audit
 * rows, written after the call answers, are kept until they commit, so the module's shutdown waits for them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRestRequest, entry, type SyncPushResponse } from '@wirebench/engine';
import { open } from '../../../src/hooks/secret-box.js';
import { HOST_CLOSE } from '../../../src/host/errors.js';
import { hostDirectories, userSecretsKey } from '../../../src/host/server-platform.js';
import type { PendingWrites } from '../../../src/pending-writes.js';
import { runTenancySteps } from '../../../src/tenancy/file-step.js';
import type { RewrapCounts, RewrapRun } from '../../../src/tenancy/rewrap.js';
import { environmentKeyRoot, newDataKey } from '../../../src/tenancy/keys.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import {
  browserUser,
  hostHarness,
  openHost,
  PUBLIC_URL,
  seedSlice2,
  storedCookie,
  type HostHarness,
} from '../../helpers/host.js';
import { workspaceSnapshot } from '../../helpers/schedule-runs.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam } from '../../helpers/teams.js';

/** A non-loopback interface of this machine: a target the egress rule lets through with private open. */
const lan = Object.values(networkInterfaces())
  .flat()
  .find((one) => one?.family === 'IPv4' && !one.internal)?.address;

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('a server host’s secrets', () => {
  let h: HostHarness;
  /** Every log line the server wrote, at `warn` and above. */
  let logged: string[];
  let writes: PendingWrites | undefined;
  let closed = false;
  /** Releases a block a failed test left held, so the harness can close. */
  let unblock: () => void = () => undefined;
  beforeEach(async () => {
    closed = false;
    unblock = () => undefined;
    writes = undefined;
    logged = [];
    h = await hostHarness({
      env: { WIREBENCH_SERVER_LOG_LEVEL: 'warn' },
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logged.push(chunk.toString('utf8'));
          done();
        },
      }),
      onSecretWrites: (made) => {
        writes = made;
      },
    });
  });
  afterEach(async () => {
    unblock();
    if (!closed) await h.close();
  });

  /** Holds every `secret.*` audit hook until `release`. */
  function blockSecretAudit(): { release(): void; readonly reached: Promise<void> } {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const isReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    unblock = () => {
      release();
    };
    h.hooks.audit.push(async (_tx, event) => {
      if (!event.action.startsWith('secret.')) return;
      reached();
      await held;
    });
    return { release, reached: isReached };
  }

  it("seals under the tenant's data key, not under the root", async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('secrets.set', { value: 'gamma-secret-0123456789', label: 'k' })).toMatchObject({
      ok: true,
    });
    const file = JSON.parse(
      await readFile(join(hostDirectories(h.dataDir, h.tdb.scope, alice.user.id).checkout, 'secrets.json'), 'utf8'),
    ) as { entries: Record<string, { value: string; encrypted: boolean }> };
    const [entry] = Object.values(file.entries);
    expect(entry?.encrypted).toBe(true);
    const sealed = Buffer.from(entry!.value, 'base64');
    const dataKey = await h.ctx.tenancy.dataKey(h.tdb.scope);
    expect(open(userSecretsKey(dataKey, alice.user.id), sealed)).toBe('gamma-secret-0123456789');
    expect(() => open(userSecretsKey(h.ctx.config.secretsKey!, alice.user.id), sealed)).toThrow();
  });

  it('settled() waits for the secret.written row the call answered before', async () => {
    const block = blockSecretAudit();
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('secrets.set', { value: 'delta-secret-0123456789', label: 'held' })).toMatchObject({
      ok: true,
    });
    await block.reached;
    let done = false;
    const settling = writes!.settled().then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    block.release();
    await settling;
    expect(h.audit.filter((event) => event.action === 'secret.written')).toHaveLength(1);
  });

  it('shutdown waits for a secret audit row still being written', async () => {
    const block = blockSecretAudit();
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('secrets.set', { value: 'eps-secret-0123456789', label: 'at close' })).toMatchObject({
      ok: true,
    });
    await block.reached;
    let closedApp = false;
    const closing = h.app.close().then(() => {
      closedApp = true;
    });
    await tick(150);
    expect(closedApp).toBe(false);
    block.release();
    await closing;
    await vi.waitFor(() => {
      expect(h.audit.filter((event) => event.action === 'secret.written')).toHaveLength(1);
    });
    closed = true;
    await h.close();
  });

  it('a data key the root does not open closes the socket 4503 before any frame, and logs the code, never a key', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const scope = h.tdb.scope;
    const before = await h.ctx.tenancy.dataKey(scope);
    // A key made under another root: what a changed WIREBENCH_SERVER_SECRETS_KEY finds in the row.
    const otherRoot = randomBytes(32);
    const otherKey = newDataKey();
    const foreign = await environmentKeyRoot(otherRoot).wrap(scope.tenantId, otherKey);
    await h.db.owner.query('update tenants set data_key = $1 where id = $2', [foreign, scope.tenantId]);
    directoryOf(h.ctx.tenancy).changed();
    const client = await openHost(h, alice);
    expect(await client.closed).toEqual({ code: HOST_CLOSE.unavailable });
    expect(client.frames).toEqual([]);
    await vi.waitFor(() => {
      expect(logged.join('')).toContain('tenancy-data-key-refused');
    });
    const text = logged.join('');
    // The tenant is named, so an operator of many tenants knows whose key is refused (re-review m2).
    expect(text).toContain(scope.tenantId);
    for (const secret of [h.ctx.config.secretsKey!, otherRoot, otherKey, before, foreign]) {
      expect(text).not.toContain(secret.toString('base64'));
      expect(text).not.toContain(secret.toString('hex'));
    }
    // No instance is kept for the failed host: the next socket tries again, and closes the same way.
    expect(h.instances().size).toBe(0);
    const again = await openHost(h, alice);
    expect(await again.closed).toEqual({ code: HOST_CLOSE.unavailable });
  });

  /** A team workspace Alice can open, whose one request sends `${secret:API_KEY}` to `url`. */
  async function workspaceFor(alice: Awaited<ReturnType<typeof browserUser>>, url: string): Promise<string> {
    const team = await seedTeam(h, { name: 'Ops', admins: [alice] });
    const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
    const requests = [
      { ...createRestRequest('Health', { id: 'req-health', url }), headers: [entry('X-Key', '${secret:API_KEY}')] },
    ];
    const changes = (await workspaceSnapshot(requests)).map((file) =>
      file.path === 'workspace.yaml'
        ? {
            path: file.path,
            encoding: 'utf8' as const,
            content: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
              .toString('utf8')
              .replace('workspace-smoke', workspaceId),
          }
        : file,
    );
    const pushed = await call<SyncPushResponse>(h, alice, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
      parent: null,
      commits: [{ subject: 'Start', at: '2026-09-24T12:00:00.000Z', changes }],
    });
    expect(pushed.status).toBe(201);
    return workspaceId;
  }

  it.skipIf(lan === undefined)(
    "after the keys step, the default tenant's host opens slice 2's secret and cookie jar, re-wrapped (plan Task 24)",
    async () => {
      const seen: string[] = [];
      const target: Server = createServer((request, response) => {
        seen.push(String(request.headers['x-key']));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"fine":true}');
      });
      await new Promise<void>((done) => target.listen(0, lan, done));
      try {
        const base = `http://${lan!}:${(target.address() as AddressInfo).port}`;
        const alice = await browserUser(h, 'alice@example.com');
        const workspaceId = await workspaceFor(alice, `${base}/ok`);
        const checkout = hostDirectories(h.dataDir, h.tdb.scope, alice.user.id).checkout;
        await seedSlice2(checkout, h.ctx.config.secretsKey!, alice.user.id, {
          workspaceId,
          label: 'wirebench-secret:project-billing:API_KEY',
          secret: 'slice2-secret-0123456789',
          cookie: [storedCookie('session', 'slice2-cookie', lan!)],
        });
        // An upgrade at `keys`: the step re-wraps both blobs, then the host opens them under the data key alone.
        await h.db.owner.query("update server_identity set tenancy_step = 'keys'");
        const counts: RewrapCounts[] = [];
        expect(
          await runTenancySteps(h.db.owner, h.dataDir, {
            root: h.ctx.config.secretsKey!,
            onRewrap: (made) => counts.push(made),
          }),
        ).toBe('done');
        expect(counts).toEqual([{ resealed: 2, already: 0, unopened: 0, skipped: 0, files: 2 }]);
        const client = await openHost(h, alice);
        await client.waitFor((frame) => frame.type === 'hello');
        expect(await client.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId })).toMatchObject({
          ok: true,
        });
        // The jar loads after the switch the join starts.
        await vi.waitFor(async () => {
          expect(await client.call('cookies.list')).toMatchObject({
            ok: true,
            value: { cookies: [expect.objectContaining({ name: 'session', value: 'slice2-cookie' })] },
          });
        });
        const sent = await client.call('request.sendRest', { sendId: 's1', requestId: 'req-health' });
        expect(sent).toMatchObject({ ok: true, value: { http: { status: 200 } } });
        // The secret opened, re-wrapped; the jar's opening is the list above.
        expect(seen).toEqual(['slice2-secret-0123456789']);
        expect(existsSync(join(checkout, 'cookie-jars', `${workspaceId}.json.corrupt`))).toBe(false);
      } finally {
        await new Promise((done) => target.close(done));
      }
    },
  );

  it("a user's directory restored after done from a backup before the upgrade is re-wrapped at the next start, and its jar opens instead of being set aside (Task 24 review I2)", async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const workspaceId = await workspaceFor(alice, 'https://restored.test/ok');
    const root = h.ctx.config.secretsKey!;
    // The upgrade reached done, with its data key.
    expect(await runTenancySteps(h.db.owner, h.dataDir, { root })).toBe('done');
    // Then the operator restores Alice's directory from a backup made before it: both blobs under the old key.
    const checkout = hostDirectories(h.dataDir, h.tdb.scope, alice.user.id).checkout;
    await seedSlice2(checkout, root, alice.user.id, {
      workspaceId,
      label: 'wirebench-secret:project-billing:API_KEY',
      secret: 'restored-secret-0123456789',
      cookie: [storedCookie('session', 'restored-cookie', 'restored.test')],
    });
    // The next start: the check at done re-seals them before any host opens.
    const seen: [RewrapCounts, RewrapRun][] = [];
    expect(
      await runTenancySteps(h.db.owner, h.dataDir, { root, onRewrap: (counts, run) => seen.push([counts, run]) }),
    ).toBe('done');
    expect(seen).toEqual([[{ resealed: 2, already: 0, unopened: 0, skipped: 0, files: 2 }, 'check']]);
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(async () => {
      expect(await client.call('cookies.list')).toMatchObject({
        ok: true,
        value: { cookies: [expect.objectContaining({ name: 'session', value: 'restored-cookie' })] },
      });
    });
    expect(existsSync(join(checkout, 'cookie-jars', `${workspaceId}.json.corrupt`))).toBe(false);
    // The secret opens under the data key's user key too.
    const file = JSON.parse(await readFile(join(checkout, 'secrets.json'), 'utf8')) as {
      entries: Record<string, { value: string }>;
    };
    const userKey = userSecretsKey(await h.ctx.tenancy.dataKey(h.tdb.scope), alice.user.id);
    expect(open(userKey, Buffer.from(file.entries['sec_slice2seededentry00000']!.value, 'base64'))).toBe(
      'restored-secret-0123456789',
    );
  });

  it('no host socket is served before the steps are done: it closes 1013, builds no host and makes no key', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    await h.db.owner.query("update server_identity set tenancy_step = 'keys'");
    const keyBefore = await h.db.owner.query<{ k: Buffer | null }>('select data_key as k from tenants where id = $1', [
      h.tdb.scope.tenantId,
    ]);
    const client = await openHost(h, alice);
    expect(await client.closed).toEqual({ code: HOST_CLOSE.tryAgainLater });
    expect(client.frames).toEqual([]);
    expect(h.instances().size).toBe(0);
    await vi.waitFor(() => {
      expect(logged.join('')).toContain('tenancy-keys-pending');
    });
    expect(existsSync(hostDirectories(h.dataDir, h.tdb.scope, alice.user.id).checkout)).toBe(false);
    const keyAfter = await h.db.owner.query<{ k: Buffer | null }>('select data_key as k from tenants where id = $1', [
      h.tdb.scope.tenantId,
    ]);
    expect(keyAfter.rows).toEqual(keyBefore.rows);
    // At done, the next socket is served.
    await h.db.owner.query("update server_identity set tenancy_step = 'done'");
    const again = await openHost(h, alice);
    await again.waitFor((frame) => frame.type === 'hello');
  });
});
