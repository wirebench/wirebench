import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LIVE_CAPABILITY, LIVE_CLOSE, LIVE_LIMITS, LIVE_PATH, type SyncPushRequest } from '@wirebench/engine';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, type RunningServer } from '../../../src/serve.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { liveHarness, openLive, rawUpgrade, type LiveHarness } from '../../helpers/live.js';
import { freePort } from '../../helpers/net.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('GET /api/v1/live (live-updates §3.1, §5.1, §6)', () => {
  let h: LiveHarness;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let team: teamsRepo.TeamRow;
  let workspaceId: string;
  beforeEach(async () => {
    h = await liveHarness();
    viewer = await signedInUser(h, { email: 'viewer@example.com' });
    stranger = await signedInUser(h, { email: 'stranger@example.com' });
    team = await seedTeam(h, { name: 'Payments QA', members: [viewer] });
    workspaceId = await seedWorkspace(h, { team, name: 'Staging' }); // default role viewer
  });
  afterEach(() => h.close());

  it('a valid token answers ready', async () => {
    const client = await openLive(h, viewer.token);
    expect(client.messages).toEqual([{ type: 'ready' }]);
    client.send({ type: 'ping' });
    expect(await client.next('pong')).toEqual({ type: 'pong' });
  });

  it('an unknown, a revoked, a disabled user’s or an expired token closes 4401', async () => {
    const refused = async (token: string): Promise<{ code: number }> => (await openLive(h, token)).closed;
    expect(await refused(mintToken().token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
    const disabled = await signedInUser(h, { email: 'gone@example.com', disabled: true });
    expect(await refused(disabled.token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
    await identityRepo.revokeToken(h.db, viewer.tokenId, h.clock.now);
    expect(await refused(viewer.token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
    h.clock.advance(31 * DAY_MS); // past the 30-day idle limit
    expect(await refused(stranger.token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
  });

  it('a socket that sends nothing closes 4408 when the auth timer fires', async () => {
    const client = await openLive(h);
    expect(h.timers.fire(LIVE_LIMITS.authTimeoutMs)).toBe(1);
    expect(await client.closed).toEqual({ code: LIVE_CLOSE.authTimeout });
  });

  it('a first message that is not auth, an off-pattern token and a second auth each close 4400', async () => {
    const early = await openLive(h);
    early.send({ type: 'subscribe', workspaceId });
    expect(await early.closed).toEqual({ code: LIVE_CLOSE.badMessage });
    const malformed = await openLive(h);
    malformed.send({ type: 'auth', token: 'not-a-token' });
    expect(await malformed.closed).toEqual({ code: LIVE_CLOSE.badMessage });
    const twice = await openLive(h, viewer.token);
    twice.send({ type: 'auth', token: viewer.token });
    expect(await twice.closed).toEqual({ code: LIVE_CLOSE.badMessage });
  });

  it('a message over 4 KiB closes 1009', async () => {
    const client = await openLive(h, viewer.token);
    client.send({ type: 'ping', padding: 'x'.repeat(5 * 1024) });
    expect(await client.closed).toEqual({ code: LIVE_CLOSE.tooBig });
  });

  it('another site’s Origin is refused 403 before the upgrade; the public origin and no Origin are upgraded', async () => {
    const foreign = await rawUpgrade(h, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    const body: unknown = JSON.parse(foreign.body);
    expect(body).toEqual({ code: 'live-origin-refused', message: expect.any(String) as string });
    expect((await rawUpgrade(h, { origin: 'null' })).status).toBe(403);
    expect((await rawUpgrade(h, { origin: 'https://wirebench.test' })).status).toBe(101);
    expect((await rawUpgrade(h, {})).status).toBe(101);
  });

  it('a stranger, or an id that exists nowhere, is refused as not found; a viewer is admitted with presence', async () => {
    const outsider = await openLive(h, stranger.token);
    outsider.send({ type: 'subscribe', workspaceId });
    expect(await outsider.next('refused')).toEqual({ type: 'refused', workspaceId, code: 'teams-workspace-not-found' });
    const nowhere = newId();
    outsider.send({ type: 'subscribe', workspaceId: nowhere });
    expect(await outsider.next('refused')).toEqual({
      type: 'refused',
      workspaceId: nowhere,
      code: 'teams-workspace-not-found',
    });
    const member = await openLive(h, viewer.token);
    member.send({ type: 'subscribe', workspaceId });
    expect(await member.next('presence')).toEqual({
      type: 'presence',
      workspaceId,
      users: [{ id: viewer.user.id, name: 'viewer' }],
    });
  });

  it('the 33rd authenticated socket of one user closes 4429', async () => {
    for (let n = 0; n < LIVE_LIMITS.maxSocketsPerUser; n += 1) {
      expect((await openLive(h, viewer.token)).messages).toEqual([{ type: 'ready' }]);
    }
    const extra = await openLive(h, viewer.token);
    expect(await extra.closed).toEqual({ code: LIVE_CLOSE.tooManySockets });
  });

  it('the 201st subscription of a session is refused live-too-many-subscriptions', async () => {
    const ids = [workspaceId];
    for (let n = 1; n <= LIVE_LIMITS.maxSubscriptionsPerSession; n += 1) {
      ids.push(await seedWorkspace(h, { team, name: `Workspace ${n}` }));
    }
    const client = await openLive(h, viewer.token);
    for (const id of ids.slice(0, LIVE_LIMITS.maxSubscriptionsPerSession)) {
      client.send({ type: 'subscribe', workspaceId: id });
      expect((await client.next('presence')).workspaceId).toBe(id);
    }
    const last = ids[LIVE_LIMITS.maxSubscriptionsPerSession]!;
    client.send({ type: 'subscribe', workspaceId: last });
    expect(await client.next('refused')).toEqual({
      type: 'refused',
      workspaceId: last,
      code: 'live-too-many-subscriptions',
    });
  });

  it('pings every 30 s and keeps a socket that answers', async () => {
    const client = await openLive(h, viewer.token);
    expect(h.timers.fire(LIVE_LIMITS.heartbeatMs)).toBe(1);
    expect(h.timers.pending(LIVE_LIMITS.heartbeatMs)).toBe(1); // re-armed
    // Two round trips: after the first, the client has sent its protocol pong; after the second, the
    // server has read it (frames on one socket arrive in order).
    for (let n = 0; n < 2; n += 1) {
      client.send({ type: 'ping' });
      await client.next('pong');
    }
    expect(h.timers.fire(LIVE_LIMITS.heartbeatMs)).toBe(1);
    client.send({ type: 'ping' });
    expect(await client.next('pong')).toEqual({ type: 'pong' }); // still open
  });

  it('meta lists the live capability, and a plain GET without an upgrade is 404', async () => {
    const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(meta.json<{ capabilities: string[] }>().capabilities).toContain(LIVE_CAPABILITY);
    expect((await h.app.inject({ method: 'GET', url: LIVE_PATH })).statusCode).toBe(404);
  });
});

/** A team admin with one device token and one repository-backed workspace, written into a running server's tables. */
async function seedAdmin(server: RunningServer): Promise<{ readonly token: string; readonly workspaceId: string }> {
  const { db, repos } = server.ctx;
  const at = new Date(); // startServer's identity runs on the real clock
  const user = await identityRepo.insertUser(db, {
    id: newId(),
    email: 'admin@example.com',
    displayName: 'admin',
    serverAdmin: false,
    at,
  });
  const { token, hash } = mintToken();
  await identityRepo.insertToken(db, { id: newId(), userId: user.id, tokenHash: hash, deviceName: 'test device', at });
  const team = await teamsRepo.insertTeam(db, { id: newId(), name: 'Payments QA', at });
  await teamsRepo.insertMember(db, { teamId: team.id, userId: user.id, role: 'admin', at });
  const workspaceId = newId();
  await teamsRepo.insertWorkspace(db, {
    id: workspaceId,
    name: 'Staging',
    teamId: team.id,
    defaultRole: 'viewer',
    createdBy: null,
    at,
  });
  await repos.withLock(workspaceId, () => repos.create(workspaceId));
  return { token, workspaceId };
}

const PUSH: SyncPushRequest = {
  parent: null,
  commits: [
    {
      subject: 'Add QA',
      at: '2026-09-26T12:00:00.000Z',
      changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'name: W\n' }],
    },
  ],
};

describeDb('live-updates at shutdown (live-updates §5.1, host spec §3.7)', () => {
  let dataDir: string;
  let port: number;
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = () => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_HOST: '127.0.0.1',
    WIREBENCH_SERVER_PORT: String(port),
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const io = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: env() });
  beforeEach(async () => {
    dataDir = await mkTempDir();
    port = await freePort();
    db = await testDatabase();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    await removeTempDir(dataDir);
  });

  it('close() sends 1001 to every socket before repos.drain(), and a push in flight still completes', async () => {
    const server = await startServer(env(), io(), {
      signals: new EventEmitter(),
      exit: vi.fn(),
      modules: BUILTIN_MODULES,
    });
    const { token, workspaceId } = await seedAdmin(server);
    const admitted = await openLive(server, token);
    expect(admitted.messages).toEqual([{ type: 'ready' }]);
    const pending = await openLive(server); // upgraded, never authenticated
    const repos = server.ctx.repos;
    const drain = repos.drain.bind(repos);
    const drained = vi.fn();
    vi.spyOn(repos, 'drain').mockImplementation(() => {
      drained();
      return drain();
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = repos.withLock(workspaceId, () => gate);
    const queued = vi.spyOn(repos, 'withLock');
    const push = fetch(`http://127.0.0.1:${server.port}/api/v1/workspaces/${workspaceId}/sync/commits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(PUSH),
    });
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1)); // the push waits behind the held lock

    const closing = server.close();
    expect(await admitted.closed).toEqual({ code: LIVE_CLOSE.goingAway });
    expect(await pending.closed).toEqual({ code: LIVE_CLOSE.goingAway });
    expect(drained).not.toHaveBeenCalled(); // both sockets were closed while the push was still in flight

    release();
    await holder;
    const response = await push;
    expect(response.status).toBe(201);
    const pushed: unknown = await response.json();
    expect(pushed).toMatchObject({ head: expect.any(String) as string });
    await closing;
    expect(drained).toHaveBeenCalledTimes(1);
  });
});
