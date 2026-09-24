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
