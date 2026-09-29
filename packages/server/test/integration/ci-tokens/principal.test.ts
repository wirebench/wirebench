/**
 * A CI principal (callback-assertion §3): it reads hooks and captures in its own workspace, and
 * nothing else — every other route, another workspace and every write answer 403 ci-token-forbidden;
 * a revoked token answers 401; last_used_at moves at most once a minute. The hooks it lists carry no
 * `url`: the catch secret would let a leaked token forge the captures it reads.
 */
import { Writable } from 'node:stream';
import type { CatchUrl } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import * as ciRepo from '../../../src/ci-tokens/repo.js';
import { hashToken } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, seedCiToken, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

interface Cast {
  readonly h: HooksHarness;
  readonly admin: SignedInUser;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly hook: CatchUrl;
  readonly otherHookId: string;
  readonly captureId: string;
  readonly ci: { readonly id: string; readonly token: string };
  readonly lines: string[];
}

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

async function setUp(): Promise<Cast> {
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
  const otherWorkspaceId = await seedWorkspace(h, { team, name: 'Staging' });
  const hook = (await call<CatchUrl>(h, admin, 'POST', `/workspaces/${workspaceId}/hooks`, { name: 'orders-hook' }))
    .body;
  const otherHook = (
    await call<CatchUrl>(h, admin, 'POST', `/workspaces/${otherWorkspaceId}/hooks`, { name: 'staging-hook' })
  ).body;
  await h.app.inject({
    method: 'POST',
    url: `${new URL(hook.url).pathname}/events`,
    headers: { 'content-type': 'application/json' },
    payload: '{"status":"paid"}',
  });
  const [capture] = (
    await call<{ id: string }[]>(h, admin, 'GET', `/workspaces/${workspaceId}/hooks/${hook.id}/captures`)
  ).body;
  const ci = await seedCiToken(h, workspaceId, 'pipeline-main', admin.user.id);
  return {
    h,
    admin,
    workspaceId,
    otherWorkspaceId,
    hook,
    otherHookId: otherHook.id,
    captureId: capture!.id,
    ci,
    lines,
  };
}

const as = (cast: Cast, method: string, path: string, token = cast.ci.token, payload?: unknown) =>
  cast.h.app.inject({
    method: method as 'GET',
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

describeDb('the CI principal (callback-assertion §3)', () => {
  it('reads whoami, the hooks and the captures of its own workspace', async () => {
    c = await setUp();
    const who = await as(c, 'GET', '/ci/whoami');
    expect(who.statusCode).toBe(200);
    expect(who.json()).toEqual({
      workspaceId: c.workspaceId,
      workspaceName: 'Integration',
      tokenName: 'pipeline-main',
    });

    const hooks = await as(c, 'GET', `/workspaces/${c.workspaceId}/hooks`);
    expect(hooks.statusCode).toBe(200);
    expect(hooks.json<CatchUrl[]>().map((hook) => hook.name)).toEqual(['orders-hook']);

    const page = await as(
      c,
      'GET',
      `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/captures?after=00000000000000000000000000&limit=200`,
    );
    expect(page.statusCode).toBe(200);
    expect(page.json<{ id: string }[]>().map((capture) => capture.id)).toEqual([c.captureId]);

    const detail = await as(c, 'GET', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/captures/${c.captureId}`);
    expect(detail.statusCode).toBe(200);
  });

  it('lists hooks without their url (the catch secret) to a CI token, and with it to a member', async () => {
    c = await setUp();
    const secret = new URL(c.hook.url).pathname.split('/').pop()!;
    expect(secret.length).toBeGreaterThan(10);

    const ci = await as(c, 'GET', `/workspaces/${c.workspaceId}/hooks`);
    expect(ci.statusCode).toBe(200);
    const [listed] = ci.json<Record<string, unknown>[]>();
    expect(listed).toMatchObject({ id: c.hook.id, name: 'orders-hook' });
    expect(Object.keys(listed!)).not.toContain('url');
    expect(ci.body).not.toContain(secret);

    const member = await call<CatchUrl[]>(c.h, c.admin, 'GET', `/workspaces/${c.workspaceId}/hooks`);
    expect(member.status).toBe(200);
    expect(member.body[0]!.url).toBe(c.hook.url);
  });

  it('answers 403 ci-token-forbidden anywhere else: another workspace, every write, every other route', async () => {
    c = await setUp();
    const hookPath = `/workspaces/${c.workspaceId}/hooks/${c.hook.id}`;
    const refused = [
      ['GET', `/workspaces/${c.otherWorkspaceId}/hooks`],
      ['GET', `/workspaces/${c.otherWorkspaceId}/hooks/${c.otherHookId}/captures`],
      ['POST', `/workspaces/${c.workspaceId}/hooks`, { name: 'refunds' }],
      ['PATCH', hookPath, { enabled: false }],
      ['DELETE', hookPath],
      ['DELETE', `${hookPath}/captures`],
      ['POST', `${hookPath}/rotate`],
      ['GET', `/workspaces/${c.workspaceId}/access`],
      ['GET', `/workspaces/${c.workspaceId}`],
      ['GET', '/me'],
      ['GET', '/teams'],
    ] as const;
    for (const [method, path, body] of refused) {
      const answer = await as(c, method, path, c.ci.token, body);
      expect([method, path, answer.statusCode, answer.json<{ code: string }>().code]).toEqual([
        method,
        path,
        403,
        'ci-token-forbidden',
      ]);
    }
    // Nothing was changed on the way: the hook is still there, still enabled, its capture kept.
    const hooks = await call<CatchUrl[]>(c.h, c.admin, 'GET', `/workspaces/${c.workspaceId}/hooks`);
    expect(hooks.body.map((hook) => [hook.name, hook.enabled, hook.captureCount, hook.url])).toEqual([
      ['orders-hook', true, 1, c.hook.url],
    ]);
  });

  it('answers 401 once revoked, and whoami refuses a device token and no token', async () => {
    c = await setUp();
    await ciRepo.revokeCiToken(c.h.db, c.workspaceId, c.ci.id, c.h.clock.now);
    const revoked = await as(c, 'GET', '/ci/whoami');
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<{ code: string }>().code).toBe('identity-unauthenticated');
    const revokedRead = await as(c, 'GET', `/workspaces/${c.workspaceId}/hooks`);
    expect(revokedRead.statusCode).toBe(401);

    const device = await as(c, 'GET', '/ci/whoami', c.admin.token);
    expect(device.statusCode).toBe(403);
    expect(device.json<{ code: string }>().code).toBe('ci-token-required');

    const anonymous = await c.h.app.inject({ method: 'GET', url: '/api/v1/ci/whoami' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<{ code: string }>().code).toBe('identity-unauthenticated');
  });

  it('writes last_used_at at most once a minute', async () => {
    c = await setUp();
    const lastUsed = async (): Promise<string | null | undefined> =>
      (await ciRepo.ciTokenByHash(c!.h.db, hashToken(c!.ci.token)))?.lastUsedAt;
    expect(await lastUsed()).toBeNull();
    await as(c, 'GET', '/ci/whoami');
    const first = c.h.clock.now.toISOString();
    expect(await lastUsed()).toBe(first);
    c.h.clock.advance(59_000);
    await as(c, 'GET', '/ci/whoami');
    expect(await lastUsed()).toBe(first);
    c.h.clock.advance(1_000);
    await as(c, 'GET', '/ci/whoami');
    expect(await lastUsed()).toBe(c.h.clock.now.toISOString());
  });

  it('never writes the token into a log line or a problem', async () => {
    c = await setUp();
    const answers = [
      await as(c, 'GET', '/ci/whoami'),
      await as(c, 'GET', `/workspaces/${c.workspaceId}/hooks`),
      await as(c, 'POST', `/workspaces/${c.workspaceId}/hooks`, c.ci.token, { name: 'refunds' }),
      await as(c, 'GET', '/me'),
    ];
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 403, 403]);
    await ciRepo.revokeCiToken(c.h.db, c.workspaceId, c.ci.id, c.h.clock.now);
    answers.push(await as(c, 'GET', '/ci/whoami'));
    expect(answers[4]!.statusCode).toBe(401);

    // Non-vacuous: the server did log these requests.
    expect(c.lines.join('').length).toBeGreaterThan(0);
    expect(c.lines.some((line) => line.includes('/api/v1/ci/whoami'))).toBe(true);
    const secretPart = c.ci.token.slice('wbs_'.length);
    for (const line of c.lines) expect(line).not.toContain(secretPart);
    for (const answer of answers) expect(answer.body).not.toContain(secretPart);
  });
});
