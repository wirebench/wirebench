import { Writable } from 'node:stream';
import { DEVICE_TOKEN_PATTERN, type CiTokenCreated, type CiTokenSummary } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, seedCatchUrl, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { newId } from '../../../src/identity/tokens.js';
import { openLive, rawUpgrade } from '../../helpers/live.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

interface Cast {
  readonly h: HooksHarness;
  readonly admin: SignedInUser;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
}

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

async function setUp(): Promise<Cast> {
  const h = await hooksHarness();
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  return { h, admin, editor, viewer, stranger, workspaceId };
}

const bearer = (cast: Cast, token: string, path: string) =>
  cast.h.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}` } });

describeDb('CI token management (callback-assertion §3)', () => {
  it('an editor creates a token, sees it once, lists it without it, and it works', async () => {
    c = await setUp();
    const created = await call<CiTokenCreated>(c.h, c.editor, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: '  pipeline-main  ',
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('pipeline-main');
    expect(created.body.token).toMatch(DEVICE_TOKEN_PATTERN);

    const listed = await call<CiTokenSummary[]>(c.h, c.editor, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        id: created.body.id,
        name: 'pipeline-main',
        createdBy: c.editor.user.displayName,
        createdAt: c.h.clock.now.toISOString(),
        lastUsedAt: null,
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    expect((await bearer(c, created.body.token, '/ci/whoami')).statusCode).toBe(200);
  });

  it('refuses a duplicate name in any case, and a blank one', async () => {
    c = await setUp();
    await call(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, { name: 'Pipeline' });
    const duplicate = await call<{ code: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: 'pipeline',
    });
    expect([duplicate.status, duplicate.body.code]).toEqual([409, 'ci-token-name-taken']);
    const blank = await call<{ code: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: '   ',
    });
    expect([blank.status, blank.body.code]).toEqual([400, 'invalid-request']);
    const long = await call<{ code: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: 'x'.repeat(65),
    });
    expect([long.status, long.body.code]).toEqual([400, 'invalid-request']);
    const paddedLong = await call<{ code: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: `  ${'x'.repeat(65)}  `,
    });
    expect([paddedLong.status, paddedLong.body.code]).toEqual([400, 'invalid-request']);
  });

  it('is for editors and admins only', async () => {
    c = await setUp();
    const byViewer = await call<{ code: string }>(c.h, c.viewer, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`);
    expect([byViewer.status, byViewer.body.code]).toEqual([403, 'teams-forbidden']);
    const byStranger = await call<{ code: string }>(c.h, c.stranger, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: 'x',
    });
    expect([byStranger.status, byStranger.body.code]).toEqual([404, 'teams-workspace-not-found']);
    const anonymous = await call(c.h, undefined, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`);
    expect(anonymous.status).toBe(401);
  });

  it('revokes: the token stops at once, and a second revoke is 404', async () => {
    c = await setUp();
    const created = (
      await call<CiTokenCreated>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, { name: 'pipeline' })
    ).body;
    const revoked = await call(c.h, c.admin, 'DELETE', `/workspaces/${c.workspaceId}/ci-tokens/${created.id}`);
    expect(revoked.status).toBe(204);
    expect((await bearer(c, created.token, '/ci/whoami')).statusCode).toBe(401);
    const again = await call<{ code: string }>(
      c.h,
      c.admin,
      'DELETE',
      `/workspaces/${c.workspaceId}/ci-tokens/${created.id}`,
    );
    expect([again.status, again.body.code]).toEqual([404, 'ci-token-not-found']);
    expect((await call<CiTokenSummary[]>(c.h, c.admin, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`)).body).toEqual(
      [],
    );
  });
  it('reuses the name of a revoked token, and trims the name it stores', async () => {
    c = await setUp();
    const path = `/workspaces/${c.workspaceId}/ci-tokens`;
    const first = (await call<CiTokenCreated>(c.h, c.admin, 'POST', path, { name: 'pipeline' })).body;
    // A live token still holds the name, whatever the padding.
    const taken = await call<{ code: string }>(c.h, c.admin, 'POST', path, { name: '  PIPELINE ' });
    expect([taken.status, taken.body.code]).toEqual([409, 'ci-token-name-taken']);
    await call(c.h, c.admin, 'DELETE', `${path}/${first.id}`);
    const again = await call<CiTokenCreated>(c.h, c.admin, 'POST', path, { name: 'pipeline' });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(first.id);
    expect(again.body.token).not.toBe(first.token);
    const listed = await call<CiTokenSummary[]>(c.h, c.admin, 'GET', path);
    expect(listed.body.map((t) => [t.id, t.name])).toEqual([[again.body.id, 'pipeline']]);
    // The 64-character limit counts after the trim.
    const edge = await call<CiTokenCreated>(c.h, c.admin, 'POST', path, { name: ` ${'x'.repeat(64)} ` });
    expect([edge.status, edge.body.name]).toEqual([201, 'x'.repeat(64)]);
  });

  it('never shows the plaintext after creation: not in the list, an error or a log', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf-8'));
        callback();
      },
    });
    const h = await hooksHarness({ env: { WIREBENCH_SERVER_LOG_LEVEL: 'info' }, logStream });
    const admin = await signedInUser(h, { email: 'admin@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
    const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
    c = { h, admin, editor: admin, viewer: admin, stranger: admin, workspaceId };
    const path = `/workspaces/${workspaceId}/ci-tokens`;
    const created = (await call<CiTokenCreated>(h, admin, 'POST', path, { name: 'pipeline' })).body;
    const secretPart = created.token.slice('wbs_'.length);
    const answers = [
      await h.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: admin.headers }),
      await h.app.inject({
        method: 'POST',
        url: `/api/v1${path}`,
        headers: admin.headers,
        payload: { name: 'pipeline' },
      }),
      await h.app.inject({ method: 'DELETE', url: `/api/v1${path}/${newId()}`, headers: admin.headers }),
    ];
    expect(answers.map((a) => a.statusCode)).toEqual([200, 409, 404]);
    for (const answer of answers) {
      expect(answer.body).not.toContain(secretPart);
      expect(Object.keys(answer.json<unknown[] | object>())).not.toContain('token');
    }
    const listed = answers[0]!.json<Record<string, unknown>[]>();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('token');
    // Non-vacuous: the server did log these requests.
    expect(lines.some((line) => line.includes('/ci-tokens'))).toBe(true);
    for (const line of lines) expect(line).not.toContain(secretPart);
  });

  it('refuses a CI token on every management write, and on the live socket', async () => {
    c = await setUp();
    const own = (
      await call<CiTokenCreated>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, { name: 'pipeline' })
    ).body;
    const other = (
      await call<CiTokenCreated>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, { name: 'other' })
    ).body;
    const hook = await seedCatchUrl(c.h, c.workspaceId, 'orders-hook');
    const as = (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) =>
      c!.h.app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { authorization: `Bearer ${own.token}` },
        ...(payload !== undefined ? { payload } : {}),
      });
    // The token itself works, so the refusals below are the allow-list and not a dead token.
    expect((await as('GET', '/ci/whoami')).statusCode).toBe(200);
    const refused = [
      ['POST', `/workspaces/${c.workspaceId}/ci-tokens`, { name: 'minted-by-ci' }],
      ['GET', `/workspaces/${c.workspaceId}/ci-tokens`],
      ['DELETE', `/workspaces/${c.workspaceId}/ci-tokens/${other.id}`],
      ['DELETE', `/workspaces/${c.workspaceId}/ci-tokens/${own.id}`],
      ['DELETE', `/workspaces/${c.workspaceId}/hooks/${hook.id}`],
    ] as const;
    for (const [method, path, body] of refused) {
      const answer = await as(method, path, body);
      expect([method, path, answer.statusCode, answer.json<{ code: string }>().code]).toEqual([
        method,
        path,
        403,
        'ci-token-forbidden',
      ]);
    }
    // Nothing changed: both tokens live, no minted one, the hook kept.
    const listed = await call<CiTokenSummary[]>(c.h, c.admin, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`);
    expect(listed.body.map((t) => t.name)).toEqual(['other', 'pipeline']);
    expect((await as('GET', '/ci/whoami')).statusCode).toBe(200);
    const hooks = await call<{ id: string }[]>(c.h, c.admin, 'GET', `/workspaces/${c.workspaceId}/hooks`);
    expect(hooks.body.map((h) => h.id)).toEqual([hook.id]);

    // The live socket: a real user token gets in (so the refusal is about the CI token) ...
    const admitted = await openLive(c.h, c.admin.token);
    await expect(admitted.next('ready')).resolves.toMatchObject({ type: 'ready' });
    admitted.close();
    await admitted.closed;
    // ... an upgrade carrying a CI bearer is refused at the request ...
    // (`connection: close` so the refused connection does not keep the server from closing.) The same
    // upgrade with a user's bearer succeeds, so the 403 is the CI token's and not the request's shape.
    const upgrade = await rawUpgrade(c.h, { authorization: `Bearer ${own.token}`, connection: 'close' });
    expect([upgrade.status, (JSON.parse(upgrade.body) as { code: string }).code]).toEqual([403, 'ci-token-forbidden']);
    expect((await rawUpgrade(c.h, { authorization: `Bearer ${c.admin.token}` })).status).toBe(101);
    // ... and a CI token sent in-band is closed as unauthenticated, never admitted.
    const inBand = await openLive(c.h, own.token);
    expect(inBand.messages.some((m) => m.type === 'ready')).toBe(false);
    expect((await inBand.closed).code).toBe(4401);
  });
});
