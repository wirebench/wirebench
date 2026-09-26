/**
 * The fourteen after-commit fire sites (live-updates spec §3.2, §11). Each test drives a real route
 * over HTTP and watches two things:
 * - a probe pushed onto `ServerHooks` after the hub's listeners, which records exactly what was
 *   announced;
 * - real sockets on the hub, which show what reached whom.
 *
 * The probe proves "announces nothing". The hub stays silent for an unchanged role, so a socket alone
 * cannot tell a rolled-back change from an announced one that found nothing to do (§15, hook coupling).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LIVE_CLOSE,
  type LiveServerMessage,
  type SyncChange,
  type SyncPushCommit,
  type SyncPushResponse,
} from '@wirebench/engine';
import type { AccessChanged, HeadMoved, SessionEnded } from '../../../src/context.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { liveHarness, openLive, type LiveTestClient } from '../../helpers/live.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam, type Method } from '../../helpers/teams.js';

type Harness = Awaited<ReturnType<typeof liveHarness>>;
type MessageType = LiveServerMessage['type'];
type Message<T extends MessageType> = Extract<LiveServerMessage, { type: T }>;

/** One `announce` call that reached the lists, in the order the routes made them. */
type Heard =
  | { readonly hook: 'headMoved'; readonly event: HeadMoved }
  | { readonly hook: 'accessChanged'; readonly event: AccessChanged }
  | { readonly hook: 'sessionEnded'; readonly event: SessionEnded };

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple battery horse';
const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (content: string): SyncPushCommit => ({
  subject: `Set ${content.trim()}`,
  at: AT,
  changes: [text('workspace.yaml', content)],
});

interface Cast {
  readonly h: Harness;
  /** Team admin, so admin of the workspace. */
  readonly admin: SignedInUser;
  /** A member with an `editor` grant and a password. */
  readonly editor: SignedInUser;
  /** A member at the workspace's default role, `viewer`. */
  readonly viewer: SignedInUser;
  /** On no team. */
  readonly stranger: SignedInUser;
  /** A server admin on no team: the one who may patch users. */
  readonly root: SignedInUser;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly heard: { take(): Heard[] };
  /** Every socket a test opened, closed in `tearDown`. */
  readonly clients: LiveTestClient[];
}

/** Records every announcement; `take` returns what was heard since the last call and starts over. */
function probe(h: Harness): { take(): Heard[] } {
  const heard: Heard[] = [];
  h.hooks.headMoved.push((event) => {
    heard.push({ hook: 'headMoved', event });
  });
  h.hooks.accessChanged.push((event) => {
    heard.push({ hook: 'accessChanged', event });
  });
  h.hooks.sessionEnded.push((event) => {
    heard.push({ hook: 'sessionEnded', event });
  });
  return { take: () => heard.splice(0) };
}

async function setUp(): Promise<Cast> {
  const h = await liveHarness();
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com', password: PASSWORD });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  return { h, admin, editor, viewer, stranger, root, teamId: team.id, workspaceId, heard: probe(h), clients: [] };
}

async function tearDown(c: Cast): Promise<void> {
  for (const client of c.clients) client.close();
  await c.h.close();
}

/** A second device token for `user`, as a second signed-in app would hold. */
async function secondDevice(c: Cast, user: SignedInUser): Promise<SignedInUser> {
  const { token, hash } = mintToken();
  const tokenId = newId();
  await identityRepo.insertToken(c.h.db, {
    id: tokenId,
    userId: user.user.id,
    tokenHash: hash,
    deviceName: 'second device',
    at: c.h.clock.now,
  });
  return { user: user.user, token, tokenId, headers: { authorization: `Bearer ${token}` } };
}

/** A socket bound to `device`'s session. `ready` proves the binding before the test acts. */
async function connect(c: Cast, device: SignedInUser): Promise<LiveTestClient> {
  const client = await openLive(c.h, device.token);
  c.clients.push(client);
  if (!client.messages.some((m) => m.type === 'ready')) await client.next('ready');
  return client;
}

/** The first message of `type` that `match` accepts; older ones of that type are consumed on the way. */
async function until<T extends MessageType>(
  client: LiveTestClient,
  type: T,
  match: (message: Message<T>) => boolean,
): Promise<Message<T>> {
  for (;;) {
    const message = await client.next(type);
    if (match(message)) return message;
  }
}

const idsOf = (users: readonly { readonly id: string }[]): string =>
  users
    .map((u) => u.id)
    .sort()
    .join(',');

/**
 * Subscribes every socket, then waits until each has seen the full list of users. Every earlier
 * `presence` is consumed on the way, so a later `until(…, 'presence', …)` reads only what came after.
 */
async function subscribeAll(
  workspaceId: string,
  sockets: readonly (readonly [LiveTestClient, SignedInUser])[],
): Promise<void> {
  for (const [client] of sockets) client.send({ type: 'subscribe', workspaceId });
  const everyone = idsOf([...new Set(sockets.map(([, device]) => device.user.id))].map((id) => ({ id })));
  for (const [client] of sockets) {
    await until(client, 'presence', (m) => m.workspaceId === workspaceId && idsOf(m.users) === everyone);
  }
}

/**
 * A ping round trip. Frames on one socket arrive in order, and a request's synchronous announcements
 * are written before its reply. Once the `pong` is back, anything the request sent this socket is
 * already in `messages`.
 */
async function settled(client: LiveTestClient): Promise<void> {
  client.send({ type: 'ping' });
  await client.next('pong');
}

const count = (client: LiveTestClient, type: MessageType): number =>
  client.messages.filter((m) => m.type === type).length;

const push = (c: Cast, as: SignedInUser, parent: string | null, content: string) =>
  call<SyncPushResponse>(c.h, as, 'POST', `/workspaces/${c.workspaceId}/sync/commits`, {
    parent,
    commits: [commit(content)],
  });

describeDb('announcements from server-sync and teams-access (§3.2)', () => {
  let c: Cast;
  beforeEach(async () => {
    c = await setUp();
  });
  afterEach(() => tearDown(c));

  it('a push sends head to every other session on the workspace, the pusher’s second device included (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const pusher = await connect(c, c.editor);
    const other = await connect(c, phone);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [pusher, c.editor],
      [other, phone],
      [viewer, c.viewer],
    ]);

    const res = await push(c, c.editor, null, 'a\n');
    expect(res.status).toBe(201);
    const head = { type: 'head', workspaceId: c.workspaceId, head: res.body.head };
    expect(await viewer.next('head')).toEqual(head);
    expect(await other.next('head')).toEqual(head);
    await settled(pusher);
    expect(count(pusher, 'head')).toBe(0);
    expect(c.heard.take()).toEqual([
      { hook: 'headMoved', event: { workspaceId: c.workspaceId, head: res.body.head, tokenId: c.editor.tokenId } },
    ]);
  });

  it('a rejected push, a last-admin refusal and a grant for a non-member announce nothing (§11)', async () => {
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [[viewer, c.viewer]]);
    const first = await push(c, c.editor, null, 'a\n');
    expect(first.status).toBe(201);
    await viewer.next('head');
    c.heard.take();

    // The parent is stale: the commit store refuses inside the lock, and main never moves.
    expect(await push(c, c.admin, null, 'z\n')).toMatchObject({ status: 409, body: { code: 'sync-push-rejected' } });
    // Both throw inside their transaction, so the line after it is never reached.
    expect(
      await call(c.h, c.admin, 'PATCH', `/teams/${c.teamId}/members/${c.admin.user.id}`, { role: 'member' }),
    ).toMatchObject({ status: 400, body: { code: 'teams-last-admin' } });
    expect(
      await call(c.h, c.admin, 'PUT', `/workspaces/${c.workspaceId}/access/${c.stranger.user.id}`, { role: 'editor' }),
    ).toMatchObject({ status: 400, body: { code: 'teams-not-a-member' } });

    expect(c.heard.take()).toEqual([]);
    await settled(viewer);
    expect(count(viewer, 'head')).toBe(1);
    expect(count(viewer, 'access')).toBe(0);
  });

  it('a grant change sends access to that user only, and a promoted user stays subscribed (§3.1, §3.3)', async () => {
    const admin = await connect(c, c.admin);
    const editor = await connect(c, c.editor);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [editor, c.editor],
      [viewer, c.viewer],
    ]);

    const res = await call(c.h, c.admin, 'PUT', `/workspaces/${c.workspaceId}/access/${c.viewer.user.id}`, {
      role: 'editor',
    });
    expect(res.status).toBe(204);
    expect(await viewer.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    // The hub resolves every subscribed user before it sends (§3.3), so the check is over for all three.
    await Promise.all([settled(admin), settled(editor)]);
    expect(count(admin, 'access') + count(editor, 'access')).toBe(0);
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { workspaceId: c.workspaceId } }]);

    const pushed = await push(c, c.editor, null, 'a\n');
    expect((await viewer.next('head')).head).toBe(pushed.body.head);
  });

  it('removing a member drops their subscription and updates everyone else’s presence (§3.1)', async () => {
    const admin = await connect(c, c.admin);
    const editor = await connect(c, c.editor);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [editor, c.editor],
      [viewer, c.viewer],
    ]);

    expect((await call(c.h, c.admin, 'DELETE', `/teams/${c.teamId}/members/${c.viewer.user.id}`)).status).toBe(204);
    expect(await viewer.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    // Sorted by name, then id (§3.1); display names are the emails' local parts.
    const remaining = [
      { id: c.admin.user.id, name: 'admin' },
      { id: c.editor.user.id, name: 'editor' },
    ];
    for (const client of [admin, editor]) {
      expect(await until(client, 'presence', (m) => m.users.length === 2)).toEqual({
        type: 'presence',
        workspaceId: c.workspaceId,
        users: remaining,
      });
    }
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { teamId: c.teamId, userId: c.viewer.user.id } }]);

    // The socket stays open, but the workspace is no longer on it: the next push passes it by.
    await push(c, c.editor, null, 'a\n');
    await admin.next('head');
    await settled(viewer);
    expect(count(viewer, 'head')).toBe(0);
  });

  it('deleting the workspace sends access to every subscriber (§3.1)', async () => {
    const admin = await connect(c, c.admin);
    const editor = await connect(c, c.editor);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [editor, c.editor],
      [viewer, c.viewer],
    ]);

    expect((await call(c.h, c.admin, 'DELETE', `/workspaces/${c.workspaceId}`)).status).toBe(204);
    for (const client of [admin, editor, viewer]) {
      expect(await client.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    }
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { workspaceId: c.workspaceId } }]);
  });

  it('deleting the workspace still sends access when the repository move then fails', async () => {
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [[viewer, c.viewer]]);
    // The row, and with it every grant, is gone before the move: the roles have changed either way.
    const move = vi.spyOn(c.h.repos, 'remove').mockRejectedValueOnce(new Error('disk full'));
    try {
      expect((await call(c.h, c.admin, 'DELETE', `/workspaces/${c.workspaceId}`)).status).toBe(500);
    } finally {
      move.mockRestore();
    }
    expect(await viewer.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { workspaceId: c.workspaceId } }]);
  });

  it('each teams-access site announces its scope once and only on success; a rename announces nothing (§3.2)', async () => {
    const ws = c.workspaceId;
    const newcomer = await signedInUser(c.h, { email: 'newcomer@example.com' });
    const byWorkspace: AccessChanged = { workspaceId: ws };
    const newcomerScope: AccessChanged = { teamId: c.teamId, userId: newcomer.user.id };
    const byAdmin = (method: Method, path: string, payload?: object) => call(c.h, c.admin, method, path, payload);
    const expectHeard = async (
      request: Promise<{ readonly status: number }>,
      status: number,
      events: readonly AccessChanged[],
    ): Promise<void> => {
      expect((await request).status).toBe(status);
      expect(c.heard.take()).toEqual(events.map((event) => ({ hook: 'accessChanged', event })));
    };

    await expectHeard(byAdmin('PUT', `/workspaces/${ws}/access/${c.viewer.user.id}`, { role: 'editor' }), 204, [
      byWorkspace,
    ]);
    await expectHeard(byAdmin('DELETE', `/workspaces/${ws}/access/${c.viewer.user.id}`), 204, [byWorkspace]);
    await expectHeard(byAdmin('PATCH', `/workspaces/${ws}`, { name: 'Staging 2' }), 200, []);
    await expectHeard(byAdmin('PATCH', `/workspaces/${ws}`, { defaultRole: 'none' }), 200, [byWorkspace]);
    const add = { email: 'newcomer@example.com', role: 'member' };
    await expectHeard(byAdmin('POST', `/teams/${c.teamId}/members`, add), 201, [newcomerScope]);
    await expectHeard(byAdmin('POST', `/teams/${c.teamId}/members`, add), 409, []); // already a member
    await expectHeard(byAdmin('PATCH', `/teams/${c.teamId}/members/${newcomer.user.id}`, { role: 'admin' }), 200, [
      newcomerScope,
    ]);
    await expectHeard(byAdmin('DELETE', `/teams/${c.teamId}/members/${newcomer.user.id}`), 204, [newcomerScope]);
    await expectHeard(byAdmin('DELETE', `/teams/${c.teamId}/members/${c.admin.user.id}`), 400, []); // the last admin
    await expectHeard(byAdmin('DELETE', `/workspaces/${ws}`), 204, [byWorkspace]);
    await expectHeard(byAdmin('DELETE', `/workspaces/${ws}/access/${c.viewer.user.id}`), 404, []); // the guard refuses
  });
});

/** `session-ended`, then the close `4401` (§3.1). */
async function expectEnded(client: LiveTestClient): Promise<void> {
  expect(await client.next('session-ended')).toEqual({ type: 'session-ended' });
  expect(await client.closed).toMatchObject({ code: LIVE_CLOSE.unauthenticated });
}

/** Still bound: a ping round trip works, and no `session-ended` came before it. */
async function expectOpen(...clients: readonly LiveTestClient[]): Promise<void> {
  for (const client of clients) {
    await settled(client);
    expect(count(client, 'session-ended')).toBe(0);
  }
}

describeDb('announcements from identity (§3.2, R4)', () => {
  let c: Cast;
  beforeEach(async () => {
    c = await setUp();
  });
  afterEach(() => tearDown(c));

  it('sign-out ends that session’s sockets and no other (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    expect((await call(c.h, c.editor, 'POST', '/auth/sign-out')).status).toBe(204);
    await expectEnded(laptop);
    await expectOpen(other, bystander);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { tokenId: c.editor.tokenId } }]);
  });

  it('removing a device ends that device’s sockets only (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const removed = await connect(c, phone);

    expect((await call(c.h, c.editor, 'DELETE', `/me/devices/${phone.tokenId}`)).status).toBe(204);
    await expectEnded(removed);
    await expectOpen(laptop);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { tokenId: phone.tokenId } }]);
  });

  it('a password change ends every other device of the user and keeps the one that changed it (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    const res = await call(c.h, c.editor, 'POST', '/me/password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(204);
    await expectEnded(other);
    await expectOpen(laptop, bystander);
    expect(c.heard.take()).toEqual([
      { hook: 'sessionEnded', event: { userId: c.editor.user.id, exceptTokenId: c.editor.tokenId } },
    ]);
  });

  it('disabling a user ends every socket of theirs; re-enabling announces nothing; both fields announce both (§3.1, R4)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    expect((await call(c.h, c.root, 'PATCH', `/users/${c.editor.user.id}`, { disabled: true })).status).toBe(200);
    await expectEnded(laptop);
    await expectEnded(other);
    await expectOpen(bystander);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { userId: c.editor.user.id } }]);

    expect((await call(c.h, c.root, 'PATCH', `/users/${c.editor.user.id}`, { disabled: false })).status).toBe(200);
    expect(c.heard.take()).toEqual([]);

    const both = await call(c.h, c.root, 'PATCH', `/users/${c.viewer.user.id}`, { serverAdmin: true, disabled: true });
    expect(both.status).toBe(200);
    // The sockets close first, so the background access check finds none of them.
    expect(c.heard.take()).toEqual([
      { hook: 'sessionEnded', event: { userId: c.viewer.user.id } },
      { hook: 'accessChanged', event: { userId: c.viewer.user.id } },
    ]);
    await expectEnded(bystander);
  });

  it('the server-admin flag sends access to that user only (R4)', async () => {
    const admin = await connect(c, c.admin);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [viewer, c.viewer],
    ]);

    expect((await call(c.h, c.root, 'PATCH', `/users/${c.viewer.user.id}`, { serverAdmin: true })).status).toBe(200);
    expect(await viewer.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    await settled(admin);
    expect(count(admin, 'access')).toBe(0);
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { userId: c.viewer.user.id } }]);
  });

  it('an accepted password reset ends every socket the user had, and no one else’s (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    const reset = await call<{ url: string }>(c.h, c.root, 'POST', `/users/${c.editor.user.id}/password-reset`);
    expect(reset.status).toBe(201);
    expect(c.heard.take()).toEqual([]); // the link alone revokes nothing
    const secret = reset.body.url.slice(reset.body.url.lastIndexOf('/') + 1);
    const accepted = await call(c.h, undefined, 'POST', '/invitations/accept', {
      secret,
      displayName: 'Editor',
      password: NEW_PASSWORD,
      device: { name: 'new laptop' },
    });
    expect(accepted.status).toBe(201);
    await expectEnded(laptop);
    await expectEnded(other);
    await expectOpen(bystander);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { userId: c.editor.user.id } }]);
  });

  it('refused identity calls announce nothing (§3.2)', async () => {
    const phone = await secondDevice(c, c.editor);
    const refused = await Promise.all([
      call(c.h, c.editor, 'POST', '/me/password', { currentPassword: 'not the password', newPassword: NEW_PASSWORD }),
      call(c.h, c.viewer, 'DELETE', `/me/devices/${phone.tokenId}`), // not the viewer's device
      call(c.h, c.root, 'PATCH', `/users/${c.root.user.id}`, { disabled: true }), // never yourself
      call(c.h, undefined, 'POST', '/invitations/accept', {
        secret: 'A'.repeat(43),
        displayName: 'Nobody',
        password: NEW_PASSWORD,
        device: { name: 'x' },
      }),
    ]);
    expect(refused.map((r) => r.status)).toEqual([401, 404, 400, 404]);
    expect(c.heard.take()).toEqual([]);
  });
});
