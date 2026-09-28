import { afterEach, expect, it } from 'vitest';
import type { Capture, CaptureSummary, CatchUrl } from '@wirebench/engine';
import type { HooksChanged } from '../../../src/context.js';
import { newId } from '../../../src/identity/tokens.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, type Method } from '../../helpers/teams.js';

interface Cast {
  readonly h: HooksHarness;
  readonly admin: SignedInUser;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly heard: HooksChanged[];
}

async function setUp(env: Record<string, string> = {}): Promise<Cast> {
  const h = await hooksHarness({ env });
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  const otherWorkspaceId = await seedWorkspace(h, { team, name: 'Other' });
  for (const id of [workspaceId, otherWorkspaceId]) {
    await teamsRepo.upsertGrant(h.db, { workspaceId: id, userId: editor.user.id, role: 'editor', at: h.clock.now });
  }
  const heard: HooksChanged[] = [];
  h.hooks.hooksChanged.push((event) => {
    heard.push(event);
  });
  return { h, admin, editor, viewer, stranger, workspaceId, otherWorkspaceId, heard };
}

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

const hooksPath = (workspaceId: string): string => `/workspaces/${workspaceId}/hooks`;
const create = (cast: Cast, as: SignedInUser, payload: object, workspaceId = cast.workspaceId) =>
  call<CatchUrl & { code?: string }>(cast.h, as, 'POST', hooksPath(workspaceId), payload);
const post = (cast: Cast, hook: CatchUrl, path = '', payload = '{}') =>
  cast.h.app.inject({
    method: 'POST',
    url: `${new URL(hook.url).pathname}${path}`,
    headers: { 'content-type': 'application/json' },
    payload,
  });

describeDb('the management API: roles (§3.5)', () => {
  it('none → 404, viewer → reads only, editor → everything', async () => {
    c = await setUp();
    const cast = c;
    const hook = (await create(cast, cast.editor, { name: 'Payments' })).body;
    await post(cast, hook);
    const [capture] = (
      await call<CaptureSummary[]>(cast.h, cast.editor, 'GET', `${hooksPath(cast.workspaceId)}/${hook.id}/captures`)
    ).body;
    const base = `${hooksPath(cast.workspaceId)}/${hook.id}`;
    const routes: readonly (readonly [Method, string, object | undefined, 'read' | 'write'])[] = [
      ['GET', hooksPath(cast.workspaceId), undefined, 'read'],
      ['GET', `${base}/captures`, undefined, 'read'],
      ['GET', `${base}/captures/${capture!.id}`, undefined, 'read'],
      ['POST', hooksPath(cast.workspaceId), { name: 'Another' }, 'write'],
      ['PATCH', base, { enabled: true }, 'write'],
      ['POST', `${base}/rotate`, undefined, 'write'],
      ['DELETE', `${base}/captures`, undefined, 'write'],
      ['DELETE', base, undefined, 'write'],
    ];
    for (const [method, path, payload, kind] of routes) {
      const stranger = await call<{ code: string }>(cast.h, cast.stranger, method, path, payload);
      expect([method, path, stranger.status, stranger.body.code]).toEqual([
        method,
        path,
        404,
        'teams-workspace-not-found',
      ]);
      const viewer = await call<{ code?: string }>(cast.h, cast.viewer, method, path, payload);
      if (kind === 'read') expect([method, path, viewer.status]).toEqual([method, path, 200]);
      else expect([method, path, viewer.status, viewer.body.code]).toEqual([method, path, 403, 'teams-forbidden']);
    }
    for (const [method, path, payload] of routes) {
      const editor = await call(cast.h, cast.editor, method, path, payload);
      expect([method, path, editor.status < 300]).toEqual([method, path, true]);
    }
    const anonymous = await call<{ code: string }>(cast.h, undefined, 'GET', hooksPath(cast.workspaceId));
    expect([anonymous.status, anonymous.body.code]).toEqual([401, 'identity-unauthenticated']);
  });
});

describeDb('the management API: catch URLs (§3.5, §3.6)', () => {
  it('creates one with the defaults and its full URL, and remembers who made it', async () => {
    c = await setUp();
    const res = await create(c, c.editor, { name: '  Payments  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workspaceId: c.workspaceId,
      name: 'Payments',
      enabled: true,
      response: { status: 200, contentType: null, body: null, delayMs: 0 },
      captureCount: 0,
      newestCaptureId: null,
    });
    expect(res.body.url).toMatch(/^https:\/\/wirebench\.test\/hooks\/[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = (
      await c.h.db.query<{ created_by: string }>('select created_by from catch_urls where id = $1', [res.body.id])
    ).rows[0];
    expect(row?.created_by).toBe(c.editor.user.id);
    const custom = await create(c, c.admin, {
      name: 'Source',
      enabled: false,
      response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 250 },
    });
    expect(custom.body).toMatchObject({
      enabled: false,
      response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 250 },
    });
    const listed = await call<CatchUrl[]>(c.h, c.viewer, 'GET', hooksPath(c.workspaceId));
    expect(listed.body.map((hook) => hook.name)).toEqual(['Payments', 'Source']);
    expect(c.heard).toEqual([{ workspaceId: c.workspaceId }, { workspaceId: c.workspaceId }]);
  });

  it('refuses a blank or long name, a clash in any case, a bad setting, a large body and one past the cap', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_PER_WORKSPACE: '2' });
    const codeOf = async (payload: object): Promise<[number, string | undefined]> => {
      const res = await create(c!, c!.editor, payload);
      return [res.status, res.body.code];
    };
    expect(await codeOf({ name: '   ' })).toEqual([400, 'hooks-name-invalid']);
    expect(await codeOf({ name: 'x'.repeat(101) })).toEqual([400, 'invalid-request']);
    expect(await codeOf({ name: 'P', response: { status: 199 } })).toEqual([400, 'invalid-request']);
    expect(await codeOf({ name: 'P', response: { delayMs: 30_001 } })).toEqual([400, 'invalid-request']);
    expect(await codeOf({ name: 'P', response: { contentType: 'text/plain\nX-Evil: 1' } })).toEqual([
      400,
      'invalid-request',
    ]);
    // 40 000 characters pass the schema's character bound, but are 80 000 UTF-8 bytes.
    expect(await codeOf({ name: 'P', response: { body: 'é'.repeat(40_000) } })).toEqual([
      400,
      'hooks-response-too-large',
    ]);
    expect((await create(c, c.editor, { name: 'Payments' })).status).toBe(201);
    expect(await codeOf({ name: 'PAYMENTS' })).toEqual([409, 'hooks-name-taken']);
    expect((await create(c, c.editor, { name: 'Second' })).status).toBe(201);
    expect(await codeOf({ name: 'Third' })).toEqual([409, 'hooks-limit-reached']);
    expect((await create(c, c.editor, { name: 'Third' }, c.otherWorkspaceId)).status).toBe(201);
    expect(c.heard).toHaveLength(3);
  });

  it('changes, renames with the same clash rule, rotates and deletes; each change announces once', async () => {
    c = await setUp();
    const hook = (await create(c, c.editor, { name: 'Payments' })).body;
    await create(c, c.editor, { name: 'Source' });
    c.heard.length = 0;
    const base = `${hooksPath(c.workspaceId)}/${hook.id}`;
    const patched = await call<CatchUrl>(c.h, c.editor, 'PATCH', base, {
      name: 'Billing',
      enabled: false,
      response: { status: 204, body: 'ignored by 204' },
    });
    expect(patched.body).toMatchObject({
      name: 'Billing',
      enabled: false,
      response: { status: 204, body: 'ignored by 204' },
    });
    const clash = await call<{ code: string }>(c.h, c.editor, 'PATCH', base, { name: 'source' });
    expect([clash.status, clash.body.code]).toEqual([409, 'hooks-name-taken']);
    await call(c.h, c.editor, 'PATCH', base, { enabled: true, response: { body: null } });
    expect((await post(c, hook)).statusCode).toBe(204);

    const rotated = await call<CatchUrl>(c.h, c.editor, 'POST', `${base}/rotate`);
    expect(rotated.body.url).not.toBe(hook.url);
    expect((await post(c, hook)).statusCode).toBe(404);
    expect((await post(c, rotated.body)).statusCode).toBe(204);

    const gone = await call(c.h, c.editor, 'DELETE', base);
    expect(gone.status).toBe(204);
    expect((await post(c, rotated.body)).statusCode).toBe(404);
    const again = await call<{ code: string }>(c.h, c.editor, 'DELETE', base);
    expect([again.status, again.body.code]).toEqual([404, 'hooks-not-found']);
    // patch, (refused clash), patch, rotate, delete, (refused delete)
    expect(c.heard).toHaveLength(4);
  });

  it("answers 404 hooks-not-found for another workspace's catch URL, on every route", async () => {
    c = await setUp();
    const elsewhere = (await create(c, c.editor, { name: 'Elsewhere' }, c.otherWorkspaceId)).body;
    const base = `${hooksPath(c.workspaceId)}/${elsewhere.id}`;
    for (const [method, path, payload] of [
      ['PATCH', base, { enabled: false }],
      ['POST', `${base}/rotate`, undefined],
      ['DELETE', base, undefined],
      ['GET', `${base}/captures`, undefined],
      ['GET', `${base}/captures/${newId()}`, undefined],
      ['DELETE', `${base}/captures`, undefined],
    ] as const) {
      const res = await call<{ code: string }>(c.h, c.editor, method, path, payload);
      expect([method, path, res.status, res.body.code]).toEqual([method, path, 404, 'hooks-not-found']);
    }
  });
});

describeDb('the management API: captures (§3.5)', () => {
  it('pages summaries newest first, fills a gap with after, and returns one capture in full', async () => {
    c = await setUp();
    const hook = (await create(c, c.editor, { name: 'Payments' })).body;
    for (const n of [1, 2, 3]) await post(c, hook, `/e${n}?n=${n}`, JSON.stringify({ n }));
    const base = `${hooksPath(c.workspaceId)}/${hook.id}/captures`;
    const all = (await call<CaptureSummary[]>(c.h, c.viewer, 'GET', base)).body;
    expect(all.map((capture) => capture.subpath)).toEqual(['/e3', '/e2', '/e1']);
    expect(all[0]).toEqual({
      id: all[0]!.id,
      receivedAt: '2026-09-24T12:00:00.000Z',
      method: 'POST',
      subpath: '/e3',
      bodySize: 7,
      truncated: false,
      sourceIp: '127.0.0.1',
    });
    const [e3, e2, e1] = all.map((capture) => capture.id) as [string, string, string];
    const ids = async (query: string): Promise<string[]> =>
      (await call<CaptureSummary[]>(c!.h, c!.viewer, 'GET', `${base}?${query}`)).body.map((capture) => capture.id);
    expect(await ids('limit=2')).toEqual([e3, e2]);
    expect(await ids(`before=${e3}&limit=1`)).toEqual([e2]);
    expect(await ids(`after=${e1}&limit=1`)).toEqual([e2]);
    expect(await ids(`after=${e1}`)).toEqual([e3, e2]);
    const both = await call<{ code: string }>(c.h, c.viewer, 'GET', `${base}?before=${e3}&after=${e1}`);
    expect([both.status, both.body.code]).toEqual([400, 'hooks-cursor-conflict']);
    expect((await call(c.h, c.viewer, 'GET', `${base}?limit=0`)).status).toBe(400);
    expect((await call(c.h, c.viewer, 'GET', `${base}?limit=201`)).status).toBe(400);

    const full = await call<Capture>(c.h, c.viewer, 'GET', `${base}/${e2}`);
    expect(full.body).toMatchObject({ id: e2, subpath: '/e2', query: 'n=2' });
    expect(Buffer.from(full.body.body, 'base64').toString('utf8')).toBe('{"n":2}');
    expect(full.body.headers).toContainEqual(['content-type', 'application/json']);
    const missing = await call<{ code: string }>(c.h, c.viewer, 'GET', `${base}/${newId()}`);
    expect([missing.status, missing.body.code]).toEqual([404, 'hooks-capture-not-found']);

    const listed = (await call<CatchUrl[]>(c.h, c.viewer, 'GET', hooksPath(c.workspaceId))).body[0];
    expect([listed?.captureCount, listed?.newestCaptureId]).toEqual([3, e3]);
  });

  it('clears every capture, announcing once', async () => {
    c = await setUp();
    const hook = (await create(c, c.editor, { name: 'Payments' })).body;
    await post(c, hook);
    await post(c, hook);
    c.heard.length = 0;
    const base = `${hooksPath(c.workspaceId)}/${hook.id}/captures`;
    expect((await call(c.h, c.editor, 'DELETE', base)).status).toBe(204);
    expect((await call<CaptureSummary[]>(c.h, c.viewer, 'GET', base)).body).toEqual([]);
    expect(c.heard).toEqual([{ workspaceId: c.workspaceId }]);
  });
});

describeDb('WIREBENCH_SERVER_HOOKS_ENABLED=false (§3.7)', () => {
  it('registers neither the public route nor the management routes', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_ENABLED: 'false' });
    const list = await call<{ code: string }>(c.h, c.editor, 'GET', hooksPath(c.workspaceId));
    expect([list.status, list.body.code]).toEqual([404, 'not-found']);
    const publicRoute = await c.h.app.inject({ method: 'POST', url: `/hooks/${'0'.repeat(26)}` });
    expect([publicRoute.statusCode, publicRoute.json<{ code: string }>().code]).toEqual([404, 'not-found']);
    const meta = await call<{ hooks: { enabled: boolean } }>(c.h, undefined, 'GET', '/meta');
    expect(meta.body.hooks.enabled).toBe(false);
  });
});
