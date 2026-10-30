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
import {
  accessEntryPath,
  createRestRequest,
  entry,
  generateMachineKeys,
  keyRequestPath,
  nextAccessEntryId,
  signDocument,
  teamSecretsFileText,
  type RestRequestDef,
  type SyncPushResponse,
} from '@wirebench/engine';
import { HISTORY_BODY_MAX_CHARS, historyBody } from '@wirebench/wire/history-body';
import { HOST_CLOSE, HOST_LIMITS } from '../../../src/host/errors.js';
import { hostDirectories } from '../../../src/host/server-platform.js';
import { sessionCookieName } from '../../../src/identity/cookies.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { browserUser, hostHarness, openHost, openRawHost, PUBLIC_URL, type HostHarness } from '../../helpers/host.js';
import { signedInUser } from '../../helpers/identity.js';
import { workspaceSnapshot } from '../../helpers/schedule-runs.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam } from '../../helpers/teams.js';
import type { Database } from '../../../src/context.js';

const AT = '2026-09-24T12:00:00.000Z';

/** `workspaceSnapshot`'s files, its `workspace.yaml` carrying the server workspace's id as a shared one must. */
async function snapshotOf(
  workspaceId: string,
  requests: Parameters<typeof workspaceSnapshot>[0],
  extra: Record<string, string> = {},
) {
  return (await workspaceSnapshot(requests, { extra })).map((file) =>
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
    // Audited by name, never by value. The audit row is written after the call answers, so wait for it.
    await vi.waitFor(() => {
      expect(h.audit.filter((event) => event.action === 'secret.written')).toEqual([
        expect.objectContaining({
          actor: expect.objectContaining({ kind: 'user', userId: alice.user.id }) as unknown,
          target: { kind: 'user', id: alice.user.id },
          details: { name: 'alice key' },
        }),
      ]);
    });
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
        const bob = await browserUser(h, 'bob@example.com');
        const editor = await signedInUser(h, { email: 'editor@example.com' });
        const team = await seedTeam(h, { name: 'Payments QA', admins: [alice], members: [editor, bob] });
        const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
        await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
        await teamsRepo.upsertGrant(h.db, { workspaceId, userId: bob.user.id, role: 'editor', at: h.clock.now });
        const requests = [
          {
            ...createRestRequest('Allowed', { id: 'req-allowed', url: `${base}/ok` }),
            headers: [entry('X-Key', '${secret:API_KEY}')],
          },
          createRestRequest('Loopback', { id: 'req-loopback', url: 'http://127.0.0.1:9/' }),
          // The same characters as Alice's secret, typed in: nothing Bob's host was ever handed as a secret.
          {
            ...createRestRequest('Literal', { id: 'req-literal', url: `${base}/literal` }),
            headers: [entry('X-Key', 'sk-fake-0123456789abcdef')],
          },
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

        // "Show secrets" is refused here (ADR-0004): values never leave the server in a frame.
        expect(await client.call('secrets.setShowSecrets', { show: true })).toMatchObject({
          ok: false,
          error: { code: 'host-capability-missing' },
        });
        expect(await client.call('secrets.getShowSecrets')).toMatchObject({ ok: true, value: { show: false } });

        const sent = await client.call('request.sendRest', { sendId: 's1', requestId: 'req-allowed' });
        expect(sent).toMatchObject({ ok: true, value: { http: { status: 200 } } });
        expect(seen).toEqual(['/ok sk-fake-0123456789abcdef']);
        // Masked in Alice's own exchange and in its cURL, as a recorded secret value.
        expect(JSON.stringify(sent)).not.toContain('sk-fake');
        const curl = await client.call('log.curl', {
          entry: { kind: 'exchange', exchange: sent.value, requestId: 'req-allowed' },
          shell: 'posix',
        });
        expect(curl).toMatchObject({ ok: true });
        expect(JSON.stringify(curl)).not.toContain('sk-fake');

        // Each host has its own redactor: Alice's secret is no redaction in Bob's.
        const other = await openHost(h, bob);
        await other.waitFor((frame) => frame.type === 'hello');
        expect(await other.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId })).toMatchObject({
          ok: true,
        });
        const literal = await other.call('request.sendRest', { sendId: 'b1', requestId: 'req-literal' });
        expect(literal).toMatchObject({ ok: true, value: { http: { status: 200 } } });
        expect(JSON.stringify(literal)).toContain('sk-fake-0123456789abcdef');
        other.close();
        await other.closed;
        await vi.waitFor(() => {
          expect(h.audit.filter((event) => event.action === 'secret.resolved')).toContainEqual(
            expect.objectContaining({ details: { name: 'API_KEY', target: lan } }),
          );
        });
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

  it('answers the save-time secret scan over an open server workspace, and only for an open project', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const editor = await signedInUser(h, { email: 'editor@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [alice], members: [editor] });
    const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
    await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
    const requests = [
      {
        ...createRestRequest('Leaky', { id: 'req-leaky', url: 'https://api.example.test/' }),
        headers: [entry('Authorization', 'Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyzAB')],
      },
    ];
    const first = await call<SyncPushResponse>(h, editor, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
      parent: null,
      commits: [{ subject: 'Start', at: AT, changes: await snapshotOf(workspaceId, requests) }],
    });
    expect(first.status).toBe(201);

    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId })).toMatchObject({
      ok: true,
    });

    // What a manual save does first: hold autosave, scan, release.
    const hold = await client.call('secretScan.hold', { projectIds: ['project-billing'] });
    expect(hold).toMatchObject({ ok: true });
    expect(typeof (hold.value as { holdId?: unknown }).holdId).toBe('string');
    const scan = await client.call('secretScan.scan', { projectId: 'project-billing' });
    expect(scan, JSON.stringify(scan)).toMatchObject({ ok: true, value: { findings: [expect.anything()] } });
    // Masked previews only: the value never rides a frame.
    expect(JSON.stringify(scan)).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    expect(await client.call('secretScan.tokens', { projectId: 'project-billing' })).toMatchObject({
      ok: true,
      value: { tokens: [] },
    });
    expect(
      await client.call('secretScan.release', { holdId: (hold.value as { holdId: string }).holdId }),
    ).toMatchObject({ ok: true });
    // A project that is not open is no way into the checkout: the call fails and opens nothing.
    expect(await client.call('secretScan.scan', { projectId: '../../other-user' })).toMatchObject({ ok: false });
  });

  it('seals what secretScan.setValue and secretScan.move store, and reports it by name only', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const leaked = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
    const typed = 'typed-value-0123456789abcdef';
    const { client } = await joinedWorkspace(h, alice, {
      requests: [
        {
          ...createRestRequest('Leaky', { id: 'req-leaky', url: 'https://api.example.test/' }),
          headers: [entry('Authorization', `Bearer ${leaked}`)],
        },
      ],
    });

    // The opened project carried the literal token before the move; what follows must not.
    const before = client.frames.length;
    const scan = await client.call('secretScan.scan', { projectId: 'project-billing' });
    const findings = (scan.value as { findings: { id: string }[] }).findings;
    expect(findings.length, JSON.stringify(scan)).toBeGreaterThan(0);
    const moved = await client.call('secretScan.move', {
      projectId: 'project-billing',
      items: [{ id: findings[0]!.id, name: 'GITHUB_TOKEN' }],
    });
    expect(moved, JSON.stringify(moved)).toMatchObject({ ok: true, value: { moved: [findings[0]!.id] } });
    expect(
      await client.call('secretScan.setValue', { projectId: 'project-billing', name: 'TYPED_KEY', value: typed }),
    ).toMatchObject({ ok: true, value: { replaced: false } });

    // Sealed: neither value is in the user's secrets file as text.
    const sealed = await readFile(join(hostDirectories(h.dataDir, alice.user.id).checkout, 'secrets.json'));
    expect(sealed.includes(leaked)).toBe(false);
    expect(sealed.includes(typed)).toBe(false);
    // Reported by name only: one audit row per write, whose details hold a name and nothing else.
    await vi.waitFor(() => {
      const written = h.audit.filter((event) => event.action === 'secret.written');
      expect(written).toHaveLength(2);
      for (const event of written) expect(Object.keys(event.details as object)).toEqual(['name']);
    });
    expect(JSON.stringify(h.audit)).not.toContain(leaked);
    expect(JSON.stringify(h.audit)).not.toContain(typed);
    // And no frame back to the tab since the scan carries either value.
    const frames = JSON.stringify(client.frames.slice(before));
    expect(frames).not.toContain(leaked);
    expect(frames).not.toContain(typed);
  });

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

  it('records an agent send of a 30 MiB response the tab trimmed as History does, and the socket stays up', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const requests = [createRestRequest('Big', { id: 'req-big', url: 'http://127.0.0.1:9/big' })];
    const { client } = await joinedWorkspace(h, alice, { requests });
    const responseBytes = 30 * 1024 * 1024;
    // What the tab uploads (`forHistory`): the body cut as History cuts it, the bodies History never reads left out.
    const head = (text: string) => Buffer.from(text).toString('base64');
    const result = {
      sendId: 'tab-send-1',
      durationMs: 40,
      http: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
        rawHeaders: [['content-type', 'text/plain']],
        bodyBase64: '',
        rawBodyBase64: '',
        rawRequestBase64: head('GET /big HTTP/1.1\r\nhost: 127.0.0.1:9\r\n\r\n'),
        rawResponseBase64: head(`HTTP/1.1 200 OK\r\n\r\n${historyBody('z'.repeat(responseBytes))}`),
        truncated: false,
        httpVersion: '1.1',
        timings: { startedAt: AT, totalMs: 40 },
        redirects: [],
        request: { url: 'http://127.0.0.1:9/big', method: 'GET', headers: {} },
      },
      url: 'http://127.0.0.1:9/big',
      method: 'GET',
      text: historyBody('z'.repeat(responseBytes)),
      language: 'text',
      cookies: [],
      methodChanged: false,
      problems: [],
      sentFrom: 'agent',
    };
    const request = { projectId: 'project-billing', itemId: 'req-big', kind: 'rest', result, responseBytes };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(2 * 1024 * 1024);
    const answer = await client.call('exchanges.recordAgentSend', request);
    expect(answer).toMatchObject({ ok: true, value: { entry: { sentFrom: 'agent', sizeBytes: responseBytes } } });
    const entry = (answer.value as { entry: { response: { envelopeXml: string } } }).entry;
    expect(entry.response.envelopeXml.length).toBeLessThan(HISTORY_BODY_MAX_CHARS + 64);
    expect(entry.response.envelopeXml).toMatch(/… truncated, \d+ more characters$/);
    expect(await client.call('app.version')).toMatchObject({ ok: true });
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

  it('holds no team-secret key (decision 5): key channels refused, and opening a vault workspace makes none', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    // A vault already on: another admin's machine turned it on and is its first approved key.
    const theirs = generateMachineKeys();
    const now = Date.parse(AT);
    const request = signDocument(
      {
        version: 1 as const,
        keyId: theirs.keyId,
        encryptionKey: theirs.encryptionKey,
        signingKey: theirs.signingKey,
        name: 'Editor',
        email: 'editor@example.com',
        machine: 'laptop',
        requestedAt: AT,
      },
      theirs,
    );
    const genesis = signDocument(
      {
        version: 1 as const,
        id: nextAccessEntryId([], now),
        action: 'genesis' as const,
        authority: 'server' as const,
        key: theirs.keyId,
        by: theirs.keyId,
        at: AT,
      },
      theirs,
    );
    const { client, workspaceId } = await joinedWorkspace(h, alice, {
      admin: true,
      extra: () => ({
        [keyRequestPath(theirs.keyId)]: teamSecretsFileText(request),
        [accessEntryPath(genesis.id)]: teamSecretsFileText(genesis),
      }),
    });
    // The first pull has run once sync is idle at the server's head.
    await client.waitFor(
      (frame) =>
        frame.event === 'sync.statusChanged' &&
        (frame.payload as { status: { state?: string; live?: string } }).status.live === 'connected',
    );
    // Behind any refresh the pull started, on the team-secrets queue.
    expect(await client.call('teamSecrets.status')).toMatchObject({ ok: true });
    const secrets = join(hostDirectories(h.dataDir, alice.user.id).checkout, 'secrets.json');
    const stored = existsSync(secrets) ? await readFile(secrets, 'utf8') : '';
    expect(stored).not.toContain('wirebench-team-key:');
    // No key request reached the server either: the vault still has the one key it started with.
    const snapshot = await call<{ files: { path: string }[] }>(
      h,
      alice,
      'GET',
      `/workspaces/${workspaceId}/sync/snapshot`,
    );
    expect(snapshot.body.files.filter((file) => file.path.startsWith('team-secrets/keys/'))).toHaveLength(1);
    const keyCalls: [string, unknown][] = [
      ['teamSecrets.turnOn', undefined],
      ['teamSecrets.requestAccess', undefined],
      ['teamSecrets.approve', { keyId: theirs.keyId }],
    ];
    for (const [channel, request] of keyCalls) {
      expect(await client.call(channel, request), channel).toMatchObject({
        ok: false,
        error: { code: 'host-capability-missing' },
      });
    }
  });

  it('serves nothing a client sends after its session ended, though it has not answered the close', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const raw = await openRawHost(h, alice);
    try {
      await raw.waitFor((frame) => frame.opcode === 1 && frame.payload.toString('utf8').includes('"hello"'));
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-out',
        headers: { cookie: `${sessionCookieName(PUBLIC_URL)}=${alice.token}`, origin: PUBLIC_URL },
      });
      expect(res.statusCode).toBe(204);
      const close = await raw.waitFor((frame) => frame.opcode === 8);
      expect(close.payload.readUInt16BE(0)).toBe(HOST_CLOSE.unauthenticated);
      // The server is closing and waits for the answer; the client sends a call instead.
      raw.sendText(
        JSON.stringify({ id: 1, channel: 'secrets.set', request: { value: 'late-0123456789', label: 'late' } }),
      );
      raw.sendClose();
      await raw.ended;
      await vi.waitFor(() => expect(h.instances().size).toBe(0));
      await vi.waitFor(() => expect(existsSync(hostDirectories(h.dataDir, alice.user.id).temp)).toBe(false));
      expect(raw.json().filter((frame) => frame.id === 1)).toEqual([]);
      expect(h.audit.filter((event) => event.action === 'secret.written')).toEqual([]);
    } finally {
      raw.destroy();
    }
  });

  it('closes 4401 when the token was revoked between the identity check and the socket', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    // Both lookups run in tenant units, so the units' transactions are where the revoke is slipped in.
    const db = h.db as unknown as { transaction: Database['transaction'] };
    const transaction = db.transaction.bind(db);
    let lookups = 0;
    db.transaction = (fn) =>
      transaction((tx) =>
        fn({
          query: async (text, params) => {
            // The identity check's lookup is the first; revoke the token before the host module's own.
            if (text.includes('from device_tokens t join users u') && ++lookups === 2) {
              await h.db.query('update device_tokens set revoked_at = now() where id = $1', [alice.tokenId]);
            }
            return await tx.query(text, params);
          },
        }),
      );
    try {
      const client = await openHost(h, alice);
      expect(await client.closed).toEqual({ code: HOST_CLOSE.unauthenticated });
      expect(client.frames.filter((frame) => frame.type === 'hello')).toEqual([]);
      expect(lookups).toBeGreaterThanOrEqual(2);
    } finally {
      db.transaction = transaction;
    }
  });

  it(`closes a user's ${HOST_LIMITS.maxSocketsPerUser + 1}th host socket ${HOST_CLOSE.tooManySockets} before any frame`, async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const bob = await browserUser(h, 'bob@example.com');
    const open = [];
    for (let i = 0; i < HOST_LIMITS.maxSocketsPerUser; i += 1) {
      const client = await openHost(h, alice);
      await client.waitFor((frame) => frame.type === 'hello');
      open.push(client);
    }
    const extra = await openHost(h, alice);
    expect(await extra.closed).toEqual({ code: HOST_CLOSE.tooManySockets });
    expect(extra.frames).toEqual([]);
    // Another user is not held to Alice's count, and a socket that closes makes room again.
    const other = await openHost(h, bob);
    await other.waitFor((frame) => frame.type === 'hello');
    open[0]!.close();
    await open[0]!.closed;
    await vi.waitFor(async () => {
      const again = await openHost(h, alice);
      await again.waitFor((frame) => frame.type === 'hello');
    });
  });

  it('refuses a browser sign-in (authorization code) before binding the callback port', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const taken: Server = createServer();
    await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
    try {
      const port = (taken.address() as AddressInfo).port;
      const requests: RestRequestDef[] = [
        {
          ...createRestRequest('OAuth', { id: 'req-oauth', url: 'https://api.example/x' }),
          auth: {
            type: 'oauth2',
            grant: 'authorization-code',
            tokenUrl: 'https://idp.example/token',
            authorizationUrl: 'https://idp.example/authorize',
            clientId: 'app',
            scopes: ['read'],
            clientAuth: 'body',
            pkce: true,
          },
        },
      ];
      const { client } = await joinedWorkspace(h, alice, { requests });
      expect(await client.call('preferences.update', { patch: { rest: { oauth2CallbackPort: port } } })).toMatchObject({
        ok: true,
      });
      expect(await client.call('oauth2.fetchToken', { ownerId: 'req-oauth' })).toMatchObject({
        ok: false,
        error: { code: 'host-capability-missing', details: { capability: 'shell' } },
      });
    } finally {
      await new Promise((done) => taken.close(done));
    }
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

describeDb('the host socket behind a trusted proxy (hosted edition spec §17.3)', () => {
  let h: HostHarness;
  beforeEach(async () => {
    h = await hostHarness({ env: { WIREBENCH_SERVER_TRUST_PROXY: 'true' } });
  });
  afterEach(() => h.close());

  it("audits a host's call to the server, and its secret writes, from the socket's address", async () => {
    const root = await browserUser(h, 'root@example.com', { serverAdmin: true });
    const client = await openHost(h, root, { 'x-forwarded-for': '203.0.113.7' });
    await client.waitFor((frame) => frame.type === 'hello');
    expect(await client.call('team.create', { url: PUBLIC_URL, name: 'Platform' })).toMatchObject({ ok: true });
    expect(h.audit.filter((event) => event.action === 'team.created')).toEqual([
      expect.objectContaining({ ip: '203.0.113.7' }),
    ]);
    expect(await client.call('secrets.set', { value: 'proxy-0123456789', label: 'proxied' })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() =>
      expect(h.audit.filter((event) => event.action === 'secret.written')).toEqual([
        expect.objectContaining({ ip: '203.0.113.7' }),
      ]),
    );
  });
});

/**
 * Alice's team workspace on the server, pushed by `pusher` (an editor of its own unless given; a team
 * admin to push team-secrets access entries), opened over a host socket.
 */
async function joinedWorkspace(
  h: HostHarness,
  alice: Awaited<ReturnType<typeof browserUser>>,
  options: {
    readonly requests?: readonly RestRequestDef[];
    readonly extra?: (workspaceId: string) => Record<string, string>;
    readonly admin?: boolean;
  } = {},
) {
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const team = await seedTeam(
    h,
    options.admin === true
      ? { name: 'Payments QA', admins: [alice, editor] }
      : { name: 'Payments QA', admins: [alice], members: [editor] },
  );
  const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
  if (options.admin !== true) {
    await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  }
  const changes = await snapshotOf(workspaceId, options.requests ?? [], options.extra?.(workspaceId) ?? {});
  const pushed = await call<SyncPushResponse>(h, editor, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
    parent: null,
    commits: [{ subject: 'Start', at: AT, changes }],
  });
  expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
  const client = await openHost(h, alice);
  await client.waitFor((frame) => frame.type === 'hello');
  expect(await client.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId })).toMatchObject({ ok: true });
  return { client, workspaceId };
}
