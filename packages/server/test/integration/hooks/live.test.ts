/**
 * The hub's `capture` and `hooks` over real sockets (webhook-capture spec §3.6, §7): a viewer hears
 * them, a user outside the workspace does not, and a burst is merged. Captures are made through the
 * public route and catch URLs changed through the management API, so the announcements are the real
 * after-commit ones.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CaptureSummary, CatchUrl } from '@wirebench/engine';
import { CAPTURE_WINDOW_MS } from '../../../src/live/hub.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { openLive, type LiveTestClient } from '../../helpers/live.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

interface Cast {
  readonly h: HooksHarness;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
  readonly hook: CatchUrl;
  readonly clients: LiveTestClient[];
}

let c: Cast;

/** A socket for `user`, subscribed to the workspace: `presence` when admitted, `refused` when not. */
async function subscribed(user: SignedInUser, answer: 'presence' | 'refused'): Promise<LiveTestClient> {
  const client = await openLive(c.h, user.token);
  c.clients.push(client);
  client.send({ type: 'subscribe', workspaceId: c.workspaceId });
  await client.next(answer);
  return client;
}

/** A ping round trip: frames on one socket arrive in order, so what was sent before the pong has arrived. */
async function settled(client: LiveTestClient): Promise<void> {
  client.send({ type: 'ping' });
  await client.next('pong');
}

const capture = (payload: string) =>
  c.h.app.inject({
    method: 'POST',
    url: new URL(c.hook.url).pathname,
    headers: { 'content-type': 'application/json' },
    payload,
  });

const newestIds = async (): Promise<string[]> =>
  (
    await call<CaptureSummary[]>(c.h, c.viewer, 'GET', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/captures`)
  ).body.map((summary) => summary.id);

describeDb('live capture and hooks messages (§3.6)', () => {
  beforeEach(async () => {
    const h = await hooksHarness();
    const editor = await signedInUser(h, { email: 'editor@example.com' });
    const viewer = await signedInUser(h, { email: 'viewer@example.com' });
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', members: [editor, viewer] });
    const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
    await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
    const hook = (await call<CatchUrl>(h, editor, 'POST', `/workspaces/${workspaceId}/hooks`, { name: 'Payments' }))
      .body;
    c = { h, editor, viewer, stranger, workspaceId, hook, clients: [] };
  });

  afterEach(async () => {
    for (const client of c.clients) client.close();
    await c.h.close();
  });

  it('reaches a viewer of the workspace and not a user outside it', async () => {
    const viewer = await subscribed(c.viewer, 'presence');
    const stranger = await subscribed(c.stranger, 'refused');

    expect((await capture('{"n":1}')).statusCode).toBe(200);
    const [newest] = await newestIds();
    expect(await viewer.next('capture')).toEqual({
      type: 'capture',
      workspaceId: c.workspaceId,
      hookId: c.hook.id,
      captureId: newest,
    });

    await call(c.h, c.editor, 'PATCH', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}`, { enabled: false });
    expect(await viewer.next('hooks')).toEqual({ type: 'hooks', workspaceId: c.workspaceId });

    await settled(stranger);
    expect(stranger.messages.map((m) => m.type)).not.toContain('capture');
    expect(stranger.messages.map((m) => m.type)).not.toContain('hooks');
  });

  it('merges a burst: one capture at once, then one with the newest id when the window ends', async () => {
    const viewer = await subscribed(c.viewer, 'presence');

    for (const n of [1, 2, 3]) expect((await capture(`{"n":${n}}`)).statusCode).toBe(200);
    const [third, , first] = await newestIds();
    expect((await viewer.next('capture')).captureId).toBe(first);
    await settled(viewer);
    expect(viewer.messages.filter((m) => m.type === 'capture')).toHaveLength(1);

    expect(c.h.timers.fire(CAPTURE_WINDOW_MS)).toBe(1);
    expect((await viewer.next('capture')).captureId).toBe(third);
    // The trailing send opened a fresh window; it ends with nothing held.
    expect(c.h.timers.fire(CAPTURE_WINDOW_MS)).toBe(1);
    await settled(viewer);
    expect(viewer.messages.filter((m) => m.type === 'capture')).toHaveLength(2);
    expect(c.h.timers.pending(CAPTURE_WINDOW_MS)).toBe(0);
  });
});
