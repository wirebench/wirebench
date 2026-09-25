// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { normalizeServerUrl, ServerClient } from '../src/main/server-client.js';

const META = {
  name: 'wirebench-server',
  version: '2.1.1',
  apiVersion: 1,
  publicUrl: 'https://wb.test',
  auth: { local: true, oidc: false },
  capabilities: [],
};
const USER = { id: '01J8Z0000000000000000000AB', email: 'a@b.co', displayName: 'A', serverAdmin: false };
const TOKEN = `wbs_${'A'.repeat(43)}`;

function exchange(
  status: number,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): HttpExchange {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers,
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
  } as unknown as HttpExchange;
}

/** A client over a recorded `send`; `answers` are consumed in order. */
function client(...answers: (HttpExchange | Error)[]) {
  const sent: HttpRequest[] = [];
  const send = vi.fn((request: HttpRequest) => {
    sent.push(request);
    const next = answers.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? exchange(500, {}));
  });
  return {
    client: new ServerClient({
      send,
      options: () => Promise.resolve({ tls: { ca: ['pem'] }, proxy: { url: 'http://proxy.local:3128' } }),
    }),
    sent,
  };
}

describe('normalizeServerUrl', () => {
  it('keeps the origin and refuses anything that is not http(s)', () => {
    expect(normalizeServerUrl(' https://WB.test/some/path?x=1 ')).toBe('https://wb.test');
    expect(normalizeServerUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    for (const bad of ['', 'wb.test', 'ftp://wb.test', 'javascript:alert(1)'])
      expect(() => normalizeServerUrl(bad)).toThrow(expect.objectContaining({ code: 'server-url-invalid' }));
  });
});

describe('ServerClient', () => {
  it('meta asks /api/v1/meta with the CA and proxy options and parses the answer', async () => {
    const { client: c, sent } = client(exchange(200, META));
    expect(await c.meta('https://wb.test')).toEqual(META);
    expect(sent[0]).toMatchObject({
      method: 'GET',
      url: 'https://wb.test/api/v1/meta',
      tls: { ca: ['pem'] },
      proxy: { url: 'http://proxy.local:3128' },
      followRedirects: false,
    });
    expect(sent[0]?.headers['accept']).toBe('application/json');
  });

  it('tells a non-Wirebench host, an unknown api version and an unreachable one apart', async () => {
    await expect(
      client(exchange(200, '<html>', { 'content-type': 'text/html' })).client.meta('https://wb.test'),
    ).rejects.toMatchObject({ code: 'server-not-wirebench' });
    await expect(client(exchange(200, { hello: 1 })).client.meta('https://wb.test')).rejects.toMatchObject({
      code: 'server-not-wirebench',
    });
    await expect(
      client(exchange(200, { ...META, apiVersion: 2 })).client.meta('https://wb.test'),
    ).rejects.toMatchObject({ code: 'server-api-version' });
    await expect(client(new Error('ECONNREFUSED')).client.meta('https://wb.test')).rejects.toMatchObject({
      code: 'server-unreachable',
    });
  });

  it('posts JSON bodies and passes the server’s problem code through', async () => {
    const { client: c, sent } = client(
      exchange(201, { token: TOKEN, user: USER }),
      exchange(401, { code: 'identity-invalid-credentials', message: 'nope' }),
    );
    const ok = await c.signInLocal('https://wb.test', {
      email: 'a@b.co',
      password: 'p'.repeat(12),
      device: { name: 'Mac' },
    });
    expect(ok.token).toBe(TOKEN);
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://wb.test/api/v1/auth/local/sign-in' });
    expect(sent[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.body))).toEqual({
      email: 'a@b.co',
      password: 'p'.repeat(12),
      device: { name: 'Mac' },
    });
    await expect(
      c.signInLocal('https://wb.test', { email: 'a@b.co', password: 'x'.repeat(12), device: { name: 'Mac' } }),
    ).rejects.toMatchObject({ code: 'identity-invalid-credentials', message: 'nope', details: { status: 401 } });
  });

  it('sends the bearer token for me and sign-out, and treats 204 as done', async () => {
    const { client: c, sent } = client(
      exchange(200, { user: USER, methods: { local: true, oidc: [] } }),
      exchange(204, ''),
    );
    expect((await c.me('https://wb.test', TOKEN)).user.email).toBe('a@b.co');
    await c.signOut('https://wb.test', TOKEN);
    expect(sent.map((r) => r.headers['authorization'])).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    expect(sent[1]).toMatchObject({ method: 'POST', url: 'https://wb.test/api/v1/auth/sign-out' });
  });

  it('looks up and accepts invitations, and starts and completes an OIDC flow', async () => {
    const secret = 'S'.repeat(43);
    const { client: c, sent } = client(
      exchange(200, { email: 'a@b.co', methods: { local: true, oidc: true } }),
      exchange(201, { token: TOKEN, user: USER }),
      exchange(201, { flowId: 'f', authorizationUrl: 'https://idp.test/a?x=1', expiresAt: '2026-09-24T12:10:00.000Z' }),
      exchange(201, { token: TOKEN, user: USER }),
    );
    expect((await c.lookupInvitation('https://wb.test', secret)).methods.oidc).toBe(true);
    expect(sent[0]?.url).toBe(`https://wb.test/api/v1/invitations/lookup?secret=${secret}`);
    await c.acceptInvitation('https://wb.test', {
      secret,
      displayName: 'A',
      password: 'p'.repeat(12),
      device: { name: 'Mac' },
    });
    expect(
      (
        await c.startOidc('https://wb.test', {
          device: { name: 'Mac' },
          codeChallenge: 'C'.repeat(43),
          loopbackPort: 49152,
        })
      ).flowId,
    ).toBe('f');
    expect(
      (await c.completeOidc('https://wb.test', { flowId: 'f', grant: 'G'.repeat(43), codeVerifier: 'v'.repeat(43) }))
        .token,
    ).toBe(TOKEN);
  });

  it('reports a 2xx that does not match the schema as server-bad-response', async () => {
    await expect(
      client(exchange(201, { token: 'bad', user: USER })).client.signInLocal('https://wb.test', {
        email: 'a@b.co',
        password: 'p'.repeat(12),
        device: { name: 'Mac' },
      }),
    ).rejects.toMatchObject({ code: 'server-bad-response' });
  });
});

describe('ServerClient — teams (teams-access §3.2)', () => {
  const TEAM_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
  const USER_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
  const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
  const TEAM = { id: TEAM_ID, name: 'Payments QA', myRole: 'admin', createdAt: '2026-09-25T10:00:00.000Z' };
  const WORKSPACE = {
    id: WS_ID,
    name: 'Integration',
    teamId: TEAM_ID,
    teamName: 'Payments QA',
    defaultRole: 'viewer',
    myRole: 'admin',
    source: 'grant',
    createdAt: '2026-09-25T10:00:00.000Z',
  };
  const body = (request: HttpRequest | undefined): unknown =>
    request?.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(request.body));

  it('sends each call to its route with the method, the bearer and the body the server validates', async () => {
    const { client: c, sent } = client(
      exchange(200, [TEAM]),
      exchange(201, TEAM),
      exchange(200, { ...TEAM, name: 'QA' }),
      exchange(204, ''),
      exchange(200, {
        userId: USER_ID,
        email: 'b@x.co',
        displayName: 'B',
        role: 'admin',
        disabled: false,
        addedAt: 'x',
      }),
      exchange(204, ''),
      exchange(201, WORKSPACE),
      exchange(204, ''),
      exchange(204, ''),
    );
    const url = 'https://wb.test';
    expect(await c.listTeams(url, TOKEN)).toEqual([TEAM]);
    expect(await c.createTeam(url, TOKEN, 'Payments QA')).toEqual(TEAM);
    expect((await c.renameTeam(url, TOKEN, TEAM_ID, 'QA')).name).toBe('QA');
    await c.deleteTeam(url, TOKEN, TEAM_ID);
    expect((await c.setMemberRole(url, TOKEN, TEAM_ID, USER_ID, 'admin')).role).toBe('admin');
    await c.removeMember(url, TOKEN, TEAM_ID, USER_ID);
    expect(await c.createWorkspace(url, TOKEN, TEAM_ID, { name: 'Integration' })).toEqual(WORKSPACE);
    await c.setAccess(url, TOKEN, WS_ID, USER_ID, 'editor');
    await c.clearAccess(url, TOKEN, WS_ID, USER_ID);
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ['GET', 'https://wb.test/api/v1/teams'],
      ['POST', 'https://wb.test/api/v1/teams'],
      ['PATCH', `https://wb.test/api/v1/teams/${TEAM_ID}`],
      ['DELETE', `https://wb.test/api/v1/teams/${TEAM_ID}`],
      ['PATCH', `https://wb.test/api/v1/teams/${TEAM_ID}/members/${USER_ID}`],
      ['DELETE', `https://wb.test/api/v1/teams/${TEAM_ID}/members/${USER_ID}`],
      ['POST', `https://wb.test/api/v1/teams/${TEAM_ID}/workspaces`],
      ['PUT', `https://wb.test/api/v1/workspaces/${WS_ID}/access/${USER_ID}`],
      ['DELETE', `https://wb.test/api/v1/workspaces/${WS_ID}/access/${USER_ID}`],
    ]);
    expect(sent.every((r) => r.headers['authorization'] === `Bearer ${TOKEN}`)).toBe(true);
    expect([body(sent[1]), body(sent[2]), body(sent[4]), body(sent[6]), body(sent[7])]).toEqual([
      { name: 'Payments QA' },
      { name: 'QA' },
      { role: 'admin' },
      { name: 'Integration' },
      { role: 'editor' },
    ]);
    expect(sent[3]?.body).toBeUndefined();
  });

  it('parses listings and passes teams-* problems through with their status', async () => {
    const { client: c } = client(
      exchange(200, [WORKSPACE]),
      exchange(200, [
        {
          userId: USER_ID,
          email: 'b@x.co',
          displayName: 'B',
          teamRole: 'member',
          disabled: false,
          effectiveRole: 'none',
        },
      ]),
      exchange(400, { code: 'teams-last-admin', message: 'A team needs at least one admin.' }),
      exchange(200, [{ ...WORKSPACE, myRole: 'owner' }]),
    );
    expect(await c.listWorkspaces('https://wb.test', TOKEN)).toEqual([WORKSPACE]);
    expect((await c.workspaceAccess('https://wb.test', TOKEN, WS_ID))[0]?.effectiveRole).toBe('none');
    await expect(c.setMemberRole('https://wb.test', TOKEN, TEAM_ID, USER_ID, 'member')).rejects.toMatchObject({
      code: 'teams-last-admin',
      details: { status: 400 },
    });
    await expect(c.listWorkspaces('https://wb.test', TOKEN)).rejects.toMatchObject({ code: 'server-bad-response' });
  });
});
