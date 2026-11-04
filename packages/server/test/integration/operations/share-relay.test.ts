/**
 * Slice 5 Task 12 (hosted edition spec §20.6): two servers on one schema, each with its own instance row, bus and
 * internal listener. A viewer whose socket lands on B joins a share held on A through A's internal listener: A's
 * registry sees one more viewer with the viewer's identity and applies its limit, control and audit once; every
 * other token is refused; the public port has no `/internal/`; a share whose holder died is no share; and the
 * owner ending the share ends the relayed viewer.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  TERMINAL_SHARE_CLOSE,
  TERMINAL_SHARE_LIMITS,
  TERMINAL_SHARE_PATH,
  type TerminalShareInfo,
} from '@wirebench/engine';
import type { AuditInput } from '../../../src/context.js';
import { BusSignals, NotificationBus } from '../../../src/operations/bus.js';
import { InstanceRegistry } from '../../../src/operations/instances.js';
import { InternalServer } from '../../../src/operations/internal-server.js';
import { relayKey, signRelayToken, type RelayClaims } from '../../../src/operations/relay-token.js';
import { openSession } from '../../../src/db/pool.js';
import { liveModule } from '../../../src/live/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import { terminalSharesModule } from '../../../src/terminal-shares/module.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { recordingAudit } from '../../helpers/context.js';
import { openShare, sharingLicense, type ShareClient } from '../../helpers/terminal-shares.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { freePort } from '../../helpers/net.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';
import { manualTimers } from '../../helpers/timers.js';

const log = Fastify({ logger: false }).log;
const WAIT_MS = 5_000;
const SECRETS_KEY = randomBytes(32);
const KEY = relayKey(SECRETS_KEY);

/** Whether the internal listener lets this upgrade through: `open`, or `refused` when it answered without one. */
function dialInternal(url: string, token: string | undefined): Promise<'open' | 'refused'> {
  return new Promise((resolve) => {
    // Node's client takes headers in its second argument; the DOM-shaped type does not say so.
    const Dial = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
    const socket = new Dial(url.replace(/^http/, 'ws'), {
      headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    });
    socket.addEventListener('open', () => {
      socket.close();
      resolve('open');
    });
    socket.addEventListener('error', () => {
      resolve('refused');
    });
  });
}

interface Node {
  readonly h: IdentityHarness;
  readonly port: number;
  readonly registry: InstanceRegistry;
  readonly internal: InternalServer | undefined;
  readonly url: string;
  readonly bus: NotificationBus;
  readonly events: AuditInput[];
}

describeDb('the share relay between instances (hosted spec §20.6)', () => {
  let db: TestDatabase;
  let dataDir: string;
  const nodes: Node[] = [];
  const clients: ShareClient[] = [];

  beforeEach(async () => {
    db = await testDatabase();
    dataDir = await mkTempDir();
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const node of nodes.splice(0)) {
      await node.h.close();
      await node.internal?.close();
      await node.bus.stop(0);
      await node.registry.stop();
    }
    await db.close();
    await removeTempDir(dataDir);
  });

  /** One server with teams, live and terminal shares; `relay: false` is a `single` one, which never dials. */
  const node = async (options: { readonly relay?: boolean } = {}): Promise<Node> => {
    const relay = options.relay ?? true;
    const timers = manualTimers();
    const holder = randomUUID();
    const url = `http://127.0.0.1:${String(await freePort())}`;
    const registry = new InstanceRegistry({
      db,
      holder,
      mode: relay ? 'multi' : 'single',
      ...(relay ? { url } : {}),
      version: '0.0.0-test',
      setTimer: timers.setTimer,
      log: () => undefined,
    });
    await registry.start();
    const signals = new BusSignals();
    const made: { harness?: IdentityHarness } = {};
    const scopeFor = async (tenantId: string): Promise<TenantScope | undefined> =>
      made.harness === undefined ? undefined : (await directoryOf(made.harness.ctx.tenancy).get(tenantId))?.scope;
    const internal = relay ? new InternalServer({ url, holder, key: KEY, scopeFor }) : undefined;
    const h = await identityHarness({
      db,
      dataDir,
      instance: registry,
      bus: signals,
      ...(internal !== undefined ? { relay: internal } : {}),
      modules: (clock) => [
        sharingLicense(),
        teamsModule({ now: () => clock.now }),
        liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
        terminalSharesModule({ now: () => clock.now, setTimer: timers.setTimer }),
      ],
    });
    made.harness = h;
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const address = h.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    await internal?.start(log);
    const bus = new NotificationBus({
      db,
      holder,
      hooks: h.hooks,
      open: () => openSession(db.url, { applicationName: 'wirebench-test-bus' }),
      scopeFor,
      log,
      retryDelayMs: 50,
      maxRetryDelayMs: 200,
    });
    signals.attach(bus);
    await bus.start();
    const result: Node = { h, port: address.port, registry, internal, url, bus, events: recordingAudit(h.hooks) };
    nodes.push(result);
    return result;
  };

  /** A on which Ana owns a share of host `web`, B beside it, and Ben, a member who may watch. */
  const fleet = async (b: { readonly relay?: boolean } = {}) => {
    const a = await node();
    const other = await node(b);
    const ana = await signedInUser(a.h, { email: 'ana@example.com' });
    const ben = await signedInUser(a.h, { email: 'ben@example.com' });
    const team = await seedTeam(a.h, { name: 'Ops', admins: [ana], members: [ben] });
    const workspaceId = await seedWorkspace(a.h, { team, name: 'Prod' });
    const created = await call<{ shareId: string }>(a.h, ana, 'POST', `/workspaces/${workspaceId}/terminal-shares`, {
      hostName: 'web',
      cols: 80,
      rows: 24,
    });
    expect(created.status).toBe(201);
    const shareId = created.body.shareId;
    const auth = (user: SignedInUser) => ({ type: 'auth', token: user.token, workspaceId, shareId });
    const owner = await openShare(a.port, auth(ana));
    clients.push(owner);
    expect(await owner.next('ready')).toEqual({ type: 'ready', role: 'owner' });
    return { a, b: other, ana, ben, workspaceId, shareId, owner, auth };
  };

  const locations = async (h: IdentityHarness): Promise<{ share_id: string; holder: string }[]> =>
    (
      await h.tdb.query<{ share_id: string; holder: string }>(
        'select share_id, holder::text from terminal_share_locations',
      )
    ).rows;

  it('a viewer on B watches a share held on A, takes control, and A counts and audits it once', async () => {
    const { a, b, ana, ben, workspaceId, shareId, owner, auth } = await fleet();
    expect(await locations(a.h)).toEqual([{ share_id: shareId, holder: a.registry.holder }]);
    owner.sendBinary('$ uptime\r\n');
    // The join dialog's answer comes from the holder.
    const info = await call<TerminalShareInfo>(
      b.h,
      ben,
      'GET',
      `/workspaces/${workspaceId}/terminal-shares/${shareId}`,
    );
    expect(info).toEqual({ status: 200, body: { hostName: 'web', ownerName: 'ana', viewers: 0 } });

    const viewer = await openShare(b.port, auth(ben));
    clients.push(viewer);
    expect(await viewer.next('viewer-ready')).toEqual({
      type: 'viewer-ready',
      hostName: 'web',
      ownerName: 'ana',
      cols: 80,
      rows: 24,
    });
    expect(await viewer.binary(1)).toEqual(['$ uptime\r\n']);
    owner.sendBinary(' up 3 days\r\n');
    expect((await viewer.binary(2))[1]).toBe(' up 3 days\r\n');
    await expect
      .poll(() => owner.texts.filter((m) => m.type === 'presence').at(-1), { timeout: WAIT_MS })
      .toMatchObject({ viewers: [{ userId: ben.user.id, name: 'ben', control: false, requesting: false }] });

    viewer.send({ type: 'request-control' });
    await expect
      .poll(() => owner.texts.filter((m) => m.type === 'presence').at(-1), { timeout: WAIT_MS })
      .toMatchObject({ viewers: [{ userId: ben.user.id, requesting: true }] });
    owner.send({ type: 'grant', userId: ben.user.id });
    await expect
      .poll(() => viewer.texts.filter((m) => m.type === 'control').at(-1), { timeout: WAIT_MS })
      .toEqual({ type: 'control', userId: ben.user.id });
    const data = Buffer.from('ls\r').toString('base64');
    viewer.send({ type: 'input', data });
    expect(await owner.next('input')).toEqual({ type: 'input', userId: ben.user.id, data });

    // Audited once, on the holder, with the viewer's own identity; B wrote none.
    const joined = (events: AuditInput[]) => events.filter((e) => e.action === 'terminal_share.joined');
    await expect.poll(() => joined(a.events).length, { timeout: WAIT_MS }).toBe(1);
    expect(joined(a.events)[0]).toMatchObject({
      actor: { kind: 'user', userId: ben.user.id, email: 'ben@example.com', tokenId: ben.tokenId },
      target: { kind: 'terminal-share', id: shareId },
      details: { userId: ben.user.id },
    });
    expect(a.events.filter((e) => e.action === 'terminal_share.control_granted')).toHaveLength(1);
    expect(b.events.filter((e) => e.action.startsWith('terminal_share.'))).toEqual([]);
    void ana;
  });

  it('A applies its viewer limit to relayed viewers', async () => {
    const { b, ben, auth } = await fleet();
    for (let i = 0; i < TERMINAL_SHARE_LIMITS.maxViewers; i += 1) {
      const viewer = await openShare(b.port, auth(ben));
      clients.push(viewer);
      await viewer.next('viewer-ready');
    }
    const extra = await openShare(b.port, auth(ben));
    clients.push(extra);
    expect(await extra.closed).toEqual({ code: TERMINAL_SHARE_CLOSE.tooMany, reason: 'full' });
  });

  it('the owner ending the share ends the relayed viewer, and the location row goes', async () => {
    const { a, b, ben, owner, auth } = await fleet();
    const viewer = await openShare(b.port, auth(ben));
    clients.push(viewer);
    await viewer.next('viewer-ready');
    owner.send({ type: 'end' });
    expect(await viewer.next('ended')).toEqual({ type: 'ended', reason: 'ended' });
    expect(await viewer.closed).toEqual({ code: TERMINAL_SHARE_CLOSE.ended, reason: 'ended' });
    await expect.poll(() => locations(a.h), { timeout: WAIT_MS }).toEqual([]);
  });

  it('a relayed viewer leaving is one viewer fewer on A', async () => {
    const { b, ben, owner, auth } = await fleet();
    const viewer = await openShare(b.port, auth(ben));
    await viewer.next('viewer-ready');
    await expect
      .poll(() => owner.texts.filter((m) => m.type === 'presence').at(-1)?.viewers.length, { timeout: WAIT_MS })
      .toBe(1);
    viewer.close();
    await expect
      .poll(() => owner.texts.filter((m) => m.type === 'presence').at(-1)?.viewers.length, { timeout: WAIT_MS })
      .toBe(0);
  });

  it('a share whose holder died is no share, and its row is cleared', async () => {
    const { a, b, ben, workspaceId, shareId, auth } = await fleet();
    // A's instance row goes, as a dead process's is swept; its listener still answers, so only the row decides.
    await a.registry.stop();
    const viewer = await openShare(b.port, auth(ben));
    clients.push(viewer);
    expect(await viewer.closed).toEqual({ code: TERMINAL_SHARE_CLOSE.notFound, reason: 'not found' });
    const info = await call<{ code: string }>(b.h, ben, 'GET', `/workspaces/${workspaceId}/terminal-shares/${shareId}`);
    expect(info.status).toBe(404);
    expect(info.body.code).toBe('terminal-share-not-found');
    await expect.poll(() => locations(a.h), { timeout: WAIT_MS }).toEqual([]);
  });

  it('a share on another instance is no share to a `single` server, which never dials', async () => {
    const { b, ben, auth } = await fleet({ relay: false });
    const viewer = await openShare(b.port, auth(ben));
    clients.push(viewer);
    expect(await viewer.closed).toEqual({ code: TERMINAL_SHARE_CLOSE.notFound, reason: 'not found' });
  });

  it('the public port has no `/internal/`, and the internal one has nothing else', async () => {
    const { a, shareId } = await fleet();
    for (const path of [`/internal/v1/shares/${shareId}`, `/internal/v1/shares/${shareId}/info`, '/internal/']) {
      expect((await a.h.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
      expect((await fetch(`http://127.0.0.1:${String(a.port)}${path}`)).status).toBe(404);
    }
    for (const path of ['/api/v1/meta', '/healthz', '/', TERMINAL_SHARE_PATH]) {
      expect((await fetch(`${a.url}${path}`)).status).toBe(404);
    }
  });

  it('refuses every token but the one made for this holder, share and moment', async () => {
    const { a, b, ben, workspaceId, shareId } = await fleet();
    const tenantId = a.h.tdb.scope.tenantId;
    const good: Omit<RelayClaims, 'expiresAt'> = {
      tenantId,
      shareId,
      workspaceId,
      userId: ben.user.id,
      tokenId: ben.tokenId,
      holder: a.registry.holder,
      viewer: {
        name: 'ben',
        tokenExpiresAt: Date.now() + 3_600_000,
        source: { actor: { kind: 'user', userId: ben.user.id, email: 'ben@example.com', tokenId: ben.tokenId } },
      },
    };
    const join = `${a.url}/internal/v1/shares/${shareId}`;
    const info = `${join}/info`;
    const infoStatus = async (token: string | undefined): Promise<number> =>
      (await fetch(info, token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {})).status;

    expect(await dialInternal(join, signRelayToken(KEY, good, Date.now()))).toBe('open');
    expect(await infoStatus(signRelayToken(KEY, good, Date.now()))).toBe(200);

    const refused: Record<string, string | undefined> = {
      none: undefined,
      junk: 'not-a-token',
      'another holder': signRelayToken(KEY, { ...good, holder: b.registry.holder }, Date.now()),
      'another share': signRelayToken(KEY, { ...good, shareId: 'a'.repeat(26) }, Date.now()),
      'another tenant': signRelayToken(KEY, { ...good, tenantId: randomUUID() }, Date.now()),
      expired: signRelayToken(KEY, good, Date.now() - 31_000),
      'another key': signRelayToken(relayKey(randomBytes(32)), good, Date.now()),
    };
    for (const [what, token] of Object.entries(refused)) {
      expect({ what, outcome: await dialInternal(join, token) }).toEqual({ what, outcome: 'refused' });
      expect({ what, status: await infoStatus(token) }).toEqual({ what, status: 401 });
    }
    // A share id in the path that is not the token's.
    expect(
      await dialInternal(`${a.url}/internal/v1/shares/${'b'.repeat(26)}`, signRelayToken(KEY, good, Date.now())),
    ).toBe('refused');
  });
});
