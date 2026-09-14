/**
 * Every authentication scheme against a server that actually checks it, including the OAuth2 grants
 * end to end against the stub authorization server.
 *
 * The negative cases are the point: a scheme that "works" because the server does not look is no
 * evidence at all, so each route rejects a wrong credential and each test proves the difference.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendHttp } from '../../../src/http/client.js';
import type { OAuth2Auth } from '../../../src/project/model.js';
import { buildTokenRequest, parseTokenResponse, pkce, newState, authorizationUrl } from '../../../src/rest/oauth2.js';
import { sendRest } from '../../../src/rest/send.js';
import type { RestSendInput } from '../../../src/rest/send.js';
import type { SendAuth } from '../../../src/types.js';
import { startTestRestServer, type TestRestServer } from '../../helpers/test-rest-server.js';

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

function input(url: string, auth?: SendAuth): RestSendInput {
  return {
    baseUrl: server.url,
    request: { method: 'GET', url, pathParams: [], query: [], headers: [], body: { kind: 'none' } },
    settings: { timeoutMs: 5_000, followRedirects: false },
    ...(auth !== undefined ? { auth } : {}),
  };
}

describe('Basic', () => {
  it('succeeds preemptively', async () => {
    const exchange = await sendRest(
      input('/auth/basic', { type: 'basic', username: 'u', password: 'p', preemptive: true }),
    );

    expect(exchange.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: false, attempts: 1 });
  });

  it('succeeds after a challenge, in two attempts', async () => {
    const exchange = await sendRest(
      input('/auth/basic', { type: 'basic', username: 'u', password: 'p', preemptive: false }),
    );

    expect(exchange.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: true, attempts: 2 });
  });

  it('fails with the wrong password rather than appearing to work', async () => {
    const exchange = await sendRest(
      input('/auth/basic', { type: 'basic', username: 'u', password: 'wrong', preemptive: true }),
    );
    expect(exchange.status).toBe(401);
  });

  it('sends no credential at all when there are none', async () => {
    const exchange = await sendRest(input('/auth/basic'));
    expect(exchange.status).toBe(401);
    expect(exchange.auth).toBeUndefined();
  });
});

describe('Bearer', () => {
  it('succeeds with the right token and fails with a wrong one', async () => {
    expect((await sendRest(input('/auth/bearer', { type: 'bearer', token: 'good-token' }))).status).toBe(200);
    expect((await sendRest(input('/auth/bearer', { type: 'bearer', token: 'nope' }))).status).toBe(401);
  });

  it('uses a custom scheme when one is configured', async () => {
    const exchange = await sendRest(input('/echo', { type: 'bearer', token: 't', scheme: 'Token' }));
    const received = JSON.parse(exchange.text) as { headers: Record<string, string> };
    expect(received.headers.authorization).toBe('Token t');
  });
});

describe('API key', () => {
  it('succeeds in a header', async () => {
    const exchange = await sendRest(
      input('/auth/apikey', { type: 'api-key', name: 'X-Api-Key', value: 'good-key', in: 'header' }),
    );

    expect(exchange.status).toBe(200);
    expect(JSON.parse(exchange.text)).toMatchObject({ in: 'header' });
  });

  it('succeeds in the query string', async () => {
    const exchange = await sendRest(
      input('/auth/apikey', { type: 'api-key', name: 'api_key', value: 'good-key', in: 'query' }),
    );

    expect(exchange.status).toBe(200);
    expect(JSON.parse(exchange.text)).toMatchObject({ in: 'query' });
  });

  it('is refused when wrong, in either position', async () => {
    expect(
      (await sendRest(input('/auth/apikey', { type: 'api-key', name: 'X-Api-Key', value: 'bad', in: 'header' })))
        .status,
    ).toBe(403);
    expect(
      (await sendRest(input('/auth/apikey', { type: 'api-key', name: 'api_key', value: 'bad', in: 'query' }))).status,
    ).toBe(403);
  });
});

describe('OAuth2 against the stub authorization server', () => {
  const config = (overrides: Partial<OAuth2Auth> = {}): OAuth2Auth => ({
    type: 'oauth2',
    grant: 'client-credentials',
    tokenUrl: `${server.url}/oauth2/token`,
    authorizationUrl: `${server.url}/oauth2/authorize`,
    clientId: 'app',
    scopes: ['read'],
    clientAuth: 'basic',
    pkce: true,
    ...overrides,
  });

  /** Runs one token request through the real transport, as the host will. */
  async function fetchToken(
    auth: OAuth2Auth,
    grant: Parameters<typeof buildTokenRequest>[2],
    secret = 's3cret',
  ): Promise<ReturnType<typeof parseTokenResponse>> {
    const request = buildTokenRequest(auth, { clientSecret: secret }, grant);
    const exchange = await sendHttp(request);
    return parseTokenResponse({ status: exchange.status, body: exchange.body });
  }

  it('obtains a token with client credentials and uses it', async () => {
    const token = await fetchToken(config(), { grant: 'client-credentials' });

    expect(token.accessToken).toBe(server.issuedTokens.at(-1));
    expect(token.expiresAt).toBeDefined();
    expect(token.scopes).toEqual(['read']);

    const exchange = await sendRest(input('/echo', { type: 'oauth2', accessToken: token.accessToken }));
    const received = JSON.parse(exchange.text) as { headers: Record<string, string> };
    expect(received.headers.authorization).toBe(`Bearer ${token.accessToken}`);
  });

  it('sends the client credentials in the body when configured that way', async () => {
    const token = await fetchToken(config({ clientAuth: 'body' }), { grant: 'client-credentials' });
    expect(token.accessToken).toBeDefined();
  });

  it('is refused with the provider own error when the secret is wrong', async () => {
    await expect(fetchToken(config(), { grant: 'client-credentials' }, 'wrong')).rejects.toMatchObject({
      code: 'oauth2-token-error',
      message: 'Client authentication failed',
    });
  });

  it('completes an authorization-code flow with PKCE, then refreshes', async () => {
    const auth = config({ grant: 'authorization-code' });
    const pair = pkce();
    const state = newState();
    const redirectUri = 'http://127.0.0.1:9/callback';

    // The browser's part, without a browser: follow the authorize URL and read the callback.
    const authorize = await sendHttp({
      url: authorizationUrl({ config: auth, redirectUri, state, challenge: pair.challenge }),
      method: 'GET',
      headers: {},
      timeoutMs: 5_000,
      followRedirects: false,
    });
    expect(authorize.status).toBe(302);
    const callback = new URL(authorize.headers.location ?? '');
    expect(callback.searchParams.get('state')).toBe(state);
    const code = callback.searchParams.get('code') ?? '';

    const token = await fetchToken(auth, { grant: 'authorization-code', code, redirectUri, verifier: pair.verifier });
    expect(token.accessToken).toBeDefined();
    expect(token.refreshToken).toBeDefined();

    const refreshed = await fetchToken(auth, { grant: 'refresh', refreshToken: token.refreshToken ?? '' });
    expect(refreshed.accessToken).not.toBe(token.accessToken);
  });

  it('is refused when the PKCE verifier does not match the challenge', async () => {
    const auth = config({ grant: 'authorization-code' });
    const redirectUri = 'http://127.0.0.1:9/callback';
    const authorize = await sendHttp({
      url: authorizationUrl({ config: auth, redirectUri, state: 'st', challenge: pkce().challenge }),
      method: 'GET',
      headers: {},
      timeoutMs: 5_000,
      followRedirects: false,
    });
    const code = new URL(authorize.headers.location ?? '').searchParams.get('code') ?? '';

    await expect(
      fetchToken(auth, { grant: 'authorization-code', code, redirectUri, verifier: pkce().verifier }),
    ).rejects.toMatchObject({ message: 'PKCE verification failed' });
  });

  it('refuses a code a second time', async () => {
    const auth = config({ grant: 'authorization-code' });
    const redirectUri = 'http://127.0.0.1:9/callback';
    const pair = pkce();
    const authorize = await sendHttp({
      url: authorizationUrl({ config: auth, redirectUri, state: 'st', challenge: pair.challenge }),
      method: 'GET',
      headers: {},
      timeoutMs: 5_000,
      followRedirects: false,
    });
    const code = new URL(authorize.headers.location ?? '').searchParams.get('code') ?? '';
    const grant = { grant: 'authorization-code', code, redirectUri, verifier: pair.verifier } as const;

    await fetchToken(auth, grant);
    await expect(fetchToken(auth, grant)).rejects.toMatchObject({ message: 'Unknown or used code' });
  });
});

describe('cookies', () => {
  it('sends back only the cookies that match, when the request asks to', async () => {
    const first = await sendRest(input('/cookies/set'));
    expect(first.cookies.map((cookie) => cookie.name)).toEqual(['session', 'tracking']);

    // `tracking` is scoped to /deep, so a request to /cookies/read must not carry it.
    const exchange = await sendRest({
      ...input('/cookies/read'),
      cookies: first.cookies.filter((c) => c.name === 'session'),
    });
    expect(JSON.parse(exchange.text)).toEqual({ cookie: 'session=abc' });
  });

  it('sends none when the request does not ask for them', async () => {
    const exchange = await sendRest(input('/cookies/read'));
    expect(JSON.parse(exchange.text)).toEqual({ cookie: null });
  });
});
