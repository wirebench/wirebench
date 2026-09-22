import { describe, expect, it } from 'vitest';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import type { OAuth2Auth } from '../../../src/project/model.js';
import { createRunTokenSource } from '../../../src/run/oauth2-token.js';

const CONFIG: OAuth2Auth = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: '${authHost}/token',
  clientId: '${clientId}',
  clientSecretRef: 'sec_client',
  scopes: ['read'],
  clientAuth: 'basic',
  pkce: true,
};

const SCOPES = { project: {}, global: {}, system: {}, env: { authHost: 'https://auth.test', clientId: 'svc' } };

function exchange(status: number, json: Record<string, unknown>): HttpExchange {
  const body = new TextEncoder().encode(JSON.stringify(json));
  return {
    request: { url: 'https://auth.test/token', method: 'POST', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body,
    rawBody: body,
  } as unknown as HttpExchange;
}

function harness(answers: readonly HttpExchange[], secret: string | null = 's3cret') {
  const sent: HttpRequest[] = [];
  const seen: string[] = [];
  let clock = new Date('2026-09-22T10:00:00Z');
  const source = createRunTokenSource({
    getSecret: (ref) => Promise.resolve(ref === 'sec_client' && secret !== null ? secret : undefined),
    send: (request) => {
      sent.push(request);
      const answer = answers[sent.length - 1];
      return answer === undefined ? Promise.reject(new Error('no answer')) : Promise.resolve(answer);
    },
    now: () => clock,
    onSecretValue: (value) => seen.push(value),
  });
  return { source, sent, seen, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

describe('createRunTokenSource', () => {
  it('fetches a token from the expanded token URL with the client credentials', async () => {
    const h = harness([exchange(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 })]);
    await expect(h.source.accessTokenFor(CONFIG, { scopes: SCOPES, timeoutMs: 500 })).resolves.toBe('tok-1');
    expect(h.sent[0]?.url).toBe('https://auth.test/token');
    expect(h.sent[0]?.timeoutMs).toBe(500);
    expect(h.sent[0]?.headers.Authorization).toBe(`Basic ${Buffer.from('svc:s3cret').toString('base64')}`);
    expect(new TextDecoder().decode(h.sent[0]?.body)).toContain('grant_type=client_credentials');
  });

  it('reports every token obtained through onSecretValue', async () => {
    const h = harness([exchange(200, { access_token: 'tok-1', token_type: 'Bearer' })]);
    await h.source.accessTokenFor(CONFIG, { scopes: SCOPES });
    expect(h.seen).toEqual(['tok-1']);
  });

  it('sends one token request for two sends behind the same configuration', async () => {
    const h = harness([exchange(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 })]);
    await h.source.accessTokenFor(CONFIG, { scopes: SCOPES });
    await expect(h.source.accessTokenFor(CONFIG, { scopes: SCOPES })).resolves.toBe('tok-1');
    expect(h.sent).toHaveLength(1);
  });

  it('fetches again once the token is about to lapse', async () => {
    const h = harness([
      exchange(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 60 }),
      exchange(200, { access_token: 'tok-2', token_type: 'Bearer', expires_in: 60 }),
    ]);
    await h.source.accessTokenFor(CONFIG, { scopes: SCOPES });
    h.advance(45_000);
    await expect(h.source.accessTokenFor(CONFIG, { scopes: SCOPES })).resolves.toBe('tok-2');
    expect(h.sent).toHaveLength(2);
  });

  it('does not cache a failed fetch', async () => {
    const h = harness([
      exchange(400, { error: 'invalid_client' }),
      exchange(200, { access_token: 'tok-2', token_type: 'Bearer' }),
    ]);
    await expect(h.source.accessTokenFor(CONFIG, { scopes: SCOPES })).rejects.toMatchObject({
      code: 'oauth2-token-error',
    });
    await expect(h.source.accessTokenFor(CONFIG, { scopes: SCOPES })).resolves.toBe('tok-2');
    expect(h.seen).toEqual(['tok-2']);
  });

  it('refuses a client secret the run was not given', async () => {
    const h = harness([], null);
    await expect(h.source.accessTokenFor(CONFIG, { scopes: SCOPES })).rejects.toMatchObject({
      code: 'secret-missing',
      details: { ref: 'sec_client' },
    });
    expect(h.sent).toHaveLength(0);
  });

  it('refuses a token URL whose properties nothing resolves', async () => {
    const h = harness([]);
    await expect(
      h.source.accessTokenFor(CONFIG, { scopes: { project: {}, global: {}, system: {} } }),
    ).rejects.toMatchObject({
      code: 'unresolved-properties',
    });
  });

  it('uses the proxy chosen for the expanded token URL and the request TLS', async () => {
    const h = harness([exchange(200, { access_token: 'tok-1', token_type: 'Bearer' })]);
    await h.source.accessTokenFor(CONFIG, {
      scopes: SCOPES,
      tls: { rejectUnauthorized: false },
      proxy: (url) => (url === 'https://auth.test/token' ? { url: 'http://proxy.test:3128' } : undefined),
    });
    expect(h.sent[0]).toMatchObject({ tls: { rejectUnauthorized: false }, proxy: { url: 'http://proxy.test:3128' } });
  });
});
