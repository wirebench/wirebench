/**
 * `GET /api/v1/host` (hosted edition spec §5.2, §17.3) against the built host bundle: the upgrade checks,
 * the frames, the allowlist, a server workspace opened and sent from, live events reaching the tab, two
 * users kept apart, and the session's end.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRestRequest, entry, type SyncPushResponse } from '@wirebench/engine';
import { HOST_LIMITS } from '../../../src/host/errors.js';
import { hostDirectories } from '../../../src/host/server-platform.js';
import { sessionCookieName } from '../../../src/identity/cookies.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { browserUser, hostHarness, openHost, PUBLIC_URL, type HostHarness } from '../../helpers/host.js';
import { signedInUser } from '../../helpers/identity.js';
import { workspaceSnapshot } from '../../helpers/schedule-runs.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam } from '../../helpers/teams.js';

const AT = '2026-09-24T12:00:00.000Z';

/** `workspaceSnapshot`'s files, its `workspace.yaml` carrying the server workspace's id as a shared one must. */
async function snapshotOf(workspaceId: string, requests: Parameters<typeof workspaceSnapshot>[0]) {
  return (await workspaceSnapshot(requests)).map((file) =>
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
}

describeDb('the host socket (hosted edition spec §17.3)', () => {
  let h: HostHarness;
  beforeEach(async () => {
    h = await hostHarness();
  });
  afterEach(() => h.close());

  it('closes 4401 without a session and 4403 for another site or a bearer caller, before any frame', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const desktop = await signedInUser(h, { email: 'dora@example.com' });
    const cases: [Parameters<typeof openHost>[1], Record<string, string>, number][] = [
      [undefined, {}, 4401],
      // A desktop's device token is no browser session, even in the cookie.
      [desktop, {}, 4401],
      [alice, { origin: 'https://evil.test' }, 4403],
      [alice, { origin: 'null' }, 4403],
      [undefined, { authorization: `Bearer ${alice.token}` }, 4403],
    ];
    for (const [user, headers, code] of cases) {
      const client = await openHost(h, user, headers);
      expect(await client.closed).toEqual({ code });
      expect(client.frames).toEqual([]);
    }
    expect(h.instances().size).toBe(0);
  });

  it('says hello first, then answers calls: app.version, a refused channel, a bad frame', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    const hello = await client.waitFor((frame) => frame.type === 'hello');
    expect(client.frames[0]).toEqual({
      type: 'hello',
      host: 'browser',
      capabilities: ['send:public'],
      osTheme: 'light',
    });
    expect(hello).toBe(client.frames[0]);
    const version = await client.call('app.version');
    expect(version).toMatchObject({ ok: true, value: { version: '0.0.0-test' } });
    // Not registered on a host without dialogs and files, and refused by the allowlist besides.
    expect(await client.call('fs.openText', {})).toMatchObject({
      ok: false,
      error: { code: 'host-capability-missing', details: { capability: 'fs' } },
    });
    // Registered by the host, refused by the allowlist.
    expect(await client.call('account.startOidc', { url: PUBLIC_URL })).toMatchObject({
      ok: false,
      error: { code: 'host-capability-missing', details: { capability: 'account' } },
    });
    expect(await client.call('no.suchChannel')).toMatchObject({
      ok: false,
      error: { code: 'host-capability-missing' },
    });
    // A frame over the live socket's 4 KiB still reaches the host (its request is then refused by shape).
    expect(await client.call('app.version', 'x'.repeat(64 * 1024))).toMatchObject({ ok: false });
    client.sendRaw(JSON.stringify({ id: 'one', channel: 'app.version' }));
    expect(await client.closed).toEqual({ code: 4400 });
  });

  it('answers host-busy past 64 calls in flight and keeps the socket open', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    // Sent before the hello: every call waits for the host, and the 65th onwards are turned away.
    for (let id = 1_000_000; id < 1_000_070; id += 1) client.sendRaw(JSON.stringify({ id, channel: 'app.version' }));
    const busy = await client.waitFor((frame) => frame.id === 1_000_069);
    expect(busy).toMatchObject({ ok: false, error: { code: 'host-busy' } });
    await client.waitFor((frame) => frame.id === 1_000_000 && frame.ok === true);
    expect(await client.call('app.version')).toMatchObject({ ok: true });
  });

  it('account.list shows the server as signed in; signing out of it is refused', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await vi.waitFor(
      async () => {
        expect(await client.call('account.list')).toMatchObject({
          ok: true,
          value: {
            servers: [{ url: PUBLIC_URL, userId: alice.user.id, email: 'alice@example.com', signedOut: false }],
          },
        });
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(await client.call('account.signOut', { url: PUBLIC_URL })).toMatchObject({
      ok: false,
      error: { code: 'account-managed-by-server' },
    });
  });

  it('a second socket of the same user shares its instance; each user has their own', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const bob = await browserUser(h, 'bob@example.com');
    const one = await openHost(h, alice);
    const two = await openHost(h, alice);
    await one.waitFor((frame) => frame.type === 'hello');
    await two.waitFor((frame) => frame.type === 'hello');
    expect(h.instances().size).toBe(1);
    const other = await openHost(h, bob);
    await other.waitFor((frame) => frame.type === 'hello');
    expect(h.instances().size).toBe(2);

    // A secret, a preference: each in its own user's host only.
    const stored = await one.call('secrets.set', { value: 'alpha-secret-0123456789', label: 'alice key' });
    expect(stored).toMatchObject({ ok: true });
    expect(await two.call('secrets.list')).toMatchObject({
      ok: true,
      value: { entries: [expect.objectContaining({ label: 'alice key' })] },
    });
    expect(await other.call('secrets.list')).toMatchObject({ ok: true, value: { entries: [] } });
    // A preference change reaches every tab of its user's host, and no other user's.
    const prefs = await one.call('preferences.update', { patch: { ui: { logSize: 200 } } });
    expect(prefs).toMatchObject({ ok: true, value: { preferences: { ui: { logSize: 200 } } } });
    await two.waitFor(
      (frame) =>
        frame.event === 'preferences.changed' &&
        (frame.payload as { preferences: { ui: { logSize: number } } }).preferences.ui.logSize === 200,
    );
    expect(await other.call('app.version')).toMatchObject({ ok: true });
    expect(other.frames.filter((frame) => frame.event === 'preferences.changed')).toEqual([]);
    const aliceDir = hostDirectories(h.dataDir, alice.user.id).checkout;
    const bobDir = hostDirectories(h.dataDir, bob.user.id).checkout;
    expect(await readFile(join(aliceDir, 'secrets.json'), 'utf8')).not.toContain('alpha-secret');
    expect(existsSync(join(bobDir, 'secrets.json'))).toBe(false);
    // Audited by name, never by value.
    expect(h.audit.filter((event) => event.action === 'secret.written')).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'user', userId: alice.user.id }) as unknown,
        target: { kind: 'user', id: alice.user.id },
        details: { name: 'alice key' },
      }),
    ]);
    expect(JSON.stringify(h.audit)).not.toContain('alpha-secret');
  });

  it('sign-out closes the socket 4401 and evicts the instance', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { cookie: `${sessionCookieName(PUBLIC_URL)}=${alice.token}`, origin: PUBLIC_URL },
    });
    expect(res.statusCode).toBe(204);
    expect(await client.closed).toEqual({ code: 4401 });
    await vi.waitFor(() => expect(h.instances().size).toBe(0));
  });

  it('a disabled user has every socket closed 4401', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const alice = await browserUser(h, 'alice@example.com');
    const one = await openHost(h, alice);
    const two = await openHost(h, alice);
    await one.waitFor((frame) => frame.type === 'hello');
    await two.waitFor((frame) => frame.type === 'hello');
    expect((await call(h, root, 'PATCH', `/users/${alice.user.id}`, { disabled: true })).status).toBe(200);
    expect(await one.closed).toEqual({ code: 4401 });
    expect(await two.closed).toEqual({ code: 4401 });
    await vi.waitFor(() => expect(h.instances().size).toBe(0));
  });

  it('evicts the instance once the idle time has passed after the last socket closed', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    const dirs = hostDirectories(h.dataDir, alice.user.id);
    await client.call('secrets.set', { value: 'kept-0123456789', label: 'kept' });
    client.close();
    await client.closed;
    await vi.waitFor(() => expect(h.hostTimers.pending(h.idleMs)).toBe(1));
    expect(h.instances().size).toBe(1);
    expect(h.hostTimers.fire(h.idleMs)).toBe(1);
    expect(h.instances().size).toBe(0);
    await vi.waitFor(() => expect(existsSync(dirs.temp)).toBe(false));
    // The checkout stays, and a new socket gets a new instance over it.
    expect(existsSync(join(dirs.checkout, 'secrets.json'))).toBe(true);
    const again = await openHost(h, alice);
    expect(await again.call('secrets.list')).toMatchObject({
      ok: true,
      value: { entries: [expect.objectContaining({ label: 'kept' })] },
    });
  });

  // A non-loopback interface of this machine: a target the egress rule lets through with private open.
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((one) => one?.family === 'IPv4' && !one.internal)?.address;

  it.skipIf(lan === undefined)(
    'opens a server workspace, sends to an allowed target, refuses loopback, and hears another client’s push',
    async () => {
      const seen: string[] = [];
      const target: Server = createServer((request, response) => {
        seen.push(`${request.url ?? ''} ${String(request.headers['x-key'])}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"fine":true}');
      });
      await new Promise<void>((done) => target.listen(0, lan, done));
      try {
        const base = `http://${lan!}:${(target.address() as AddressInfo).port}`;
        const alice = await browserUser(h, 'alice@example.com');
        const editor = await signedInUser(h, { email: 'editor@example.com' });
        const team = await seedTeam(h, { name: 'Payments QA', admins: [alice], members: [editor] });
        const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
        await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
        const requests = [
          {
            ...createRestRequest('Allowed', { id: 'req-allowed', url: `${base}/ok` }),
            headers: [entry('X-Key', '${secret:API_KEY}')],
          },
          createRestRequest('Loopback', { id: 'req-loopback', url: 'http://127.0.0.1:9/' }),
        ];
        const first = await call<SyncPushResponse>(h, editor, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
          parent: null,
          commits: [{ subject: 'Start', at: AT, changes: await snapshotOf(workspaceId, requests) }],
        });
        expect(first.status).toBe(201);

        const client = await openHost(h, alice);
        await client.waitFor((frame) => frame.type === 'hello');
        const opened = await client.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId });
        expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
        expect(
          await client.call('secrets.set', {
            value: 'sk-fake-0123456789abcdef',
            label: 'wirebench-secret:project-billing:API_KEY',
          }),
        ).toMatchObject({ ok: true });

        const sent = await client.call('request.sendRest', { sendId: 's1', requestId: 'req-allowed' });
        expect(sent).toMatchObject({ ok: true, value: { http: { status: 200 } } });
        expect(seen).toEqual(['/ok sk-fake-0123456789abcdef']);
        expect(h.audit.filter((event) => event.action === 'secret.resolved')).toContainEqual(
          expect.objectContaining({ details: { name: 'API_KEY', target: lan } }),
        );
        expect(JSON.stringify(h.audit)).not.toContain('sk-fake');

        const refused = await client.call('request.sendRest', { sendId: 's2', requestId: 'req-loopback' });
        expect(JSON.stringify(refused)).toContain('egress-refused');

        // The host's live client is connected through the in-process bridge, so another client's push
        // reaches it as `head`, and the host tells this tab.
        await client.waitFor(
          (frame) =>
            frame.event === 'sync.statusChanged' &&
            (frame.payload as { status: { live?: string } }).status.live === 'connected',
        );
        const before = client.frames.length;
        const second = await call<SyncPushResponse>(h, editor, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
          parent: first.body.head,
          commits: [
            {
              subject: 'More',
              at: AT,
              changes: await snapshotOf(workspaceId, [
                ...requests,
                createRestRequest('Third', { id: 'req-third', url: `${base}/third` }),
              ]),
            },
          ],
        });
        expect(second.status).toBe(201);
        await client.waitFor(
          (frame) =>
            client.frames.indexOf(frame) >= before &&
            typeof frame.event === 'string' &&
            frame.event.startsWith('sync.') &&
            JSON.stringify(frame.payload).includes(workspaceId),
        );
      } finally {
        target.closeAllConnections();
        await new Promise<void>((done) => target.close(() => done()));
      }
    },
  );

  it('closes 1009 for a frame just over 32 MiB', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    const request = 'x'.repeat(HOST_LIMITS.maxFrameBytes - 40);
    const frame = JSON.stringify({ id: 1, channel: 'app.version', request });
    expect(Buffer.byteLength(frame)).toBeGreaterThan(HOST_LIMITS.maxFrameBytes);
    expect(Buffer.byteLength(frame)).toBeLessThan(HOST_LIMITS.maxFrameBytes + 64);
    client.sendRaw(frame);
    expect(await client.closed).toEqual({ code: 1009 });
  });

  it('refuses a stdio MCP send and catalogue refresh at once with host-capability-missing', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const { client } = await joinedWorkspace(h, alice);
    const server = await client.call('project.mutate', {
      projectId: 'project-billing',
      change: {
        kind: 'add-mcp-server',
        name: 'Local',
        transport: { type: 'stdio', command: process.execPath, args: ['-e', ''], env: [] },
      },
    });
    expect(server).toMatchObject({ ok: true });
    const apiId = (server.value as { createdId: string }).createdId;
    const request = await client.call('project.mutate', {
      projectId: 'project-billing',
      change: { kind: 'add-mcp-request', apiId, name: 'List', operation: { method: 'tools/list' } },
    });
    const requestId = (request.value as { createdId: string }).createdId;
    const refusal = { ok: false, error: { code: 'host-capability-missing', details: { capability: 'processes' } } };
    expect(await client.call('request.sendMcp', { sendId: 'm1', requestId })).toMatchObject(refusal);
    expect(await client.call('api.refreshMcpCatalogue', { apiId, sendId: 'm2' })).toMatchObject(refusal);
    expect(client.frames.filter((frame) => frame.event === 'mcp.approval')).toEqual([]);
  });
});

describeDb('the host socket and its token’s age (hosted edition spec §17.3)', () => {
  let h: HostHarness;
  beforeEach(async () => {
    h = await hostHarness({ env: { WIREBENCH_SERVER_TOKEN_MAX_DAYS: '1', WIREBENCH_SERVER_TOKEN_IDLE_DAYS: '1' } });
  });
  afterEach(() => h.close());
  const DAY_MS = 86_400_000;

  it('closes 4401 when the session reaches its maximum age, and not before', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    await vi.waitFor(() => expect(h.hostTimers.pending(DAY_MS)).toBe(1));
    h.hostTimers.fire(DAY_MS);
    expect(await client.closed).toEqual({ code: 4401 });
    await vi.waitFor(() => expect(h.instances().size).toBe(0));
  });

  it('cancels the deadline when the socket closes', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    await vi.waitFor(() => expect(h.hostTimers.pending(DAY_MS)).toBe(1));
    client.close();
    await client.closed;
    await vi.waitFor(() => expect(h.hostTimers.pending(DAY_MS)).toBe(0));
  });

  it('closes 4401 when a call to the server finds the token expired', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    // Idle past its limit: the next request with it is refused and the token deleted.
    h.clock.advance(DAY_MS + 1);
    void client.call('team.list');
    expect(await client.closed).toEqual({ code: 4401 });
    await vi.waitFor(() => expect(h.instances().size).toBe(0));
  });
});

/** Alice's team workspace on the server, pushed by an editor, opened over a host socket. */
async function joinedWorkspace(h: HostHarness, alice: Awaited<ReturnType<typeof browserUser>>) {
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [alice], members: [editor] });
  const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  const pushed = await call<SyncPushResponse>(h, editor, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
    parent: null,
    commits: [{ subject: 'Start', at: AT, changes: await snapshotOf(workspaceId, []) }],
  });
  expect(pushed.status).toBe(201);
  const client = await openHost(h, alice);
  await client.waitFor((frame) => frame.type === 'hello');
  expect(await client.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId })).toMatchObject({ ok: true });
  return { client, workspaceId };
}

