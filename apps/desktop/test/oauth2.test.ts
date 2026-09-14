// @vitest-environment node
/**
 * The OAuth2 token service: the stateful half the engine leaves out — the cache, the loopback
 * listener and the refresh decision — against a stub authorization server that checks what a real
 * one checks (client authentication, `state`, PKCE, the redirect URI, a used code).
 *
 * The security assertions are the ones worth having. The listener must answer on `127.0.0.1` and
 * nowhere else, must refuse a callback whose `state` it did not issue, and a send must never open a
 * browser window on its own — the last one is why `accessToken` refuses an authorization-code
 * configuration instead of authorizing.
 */
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import type { OAuth2Auth } from '@wirebench/engine';
import { OAuth2Service, tokenCacheKey } from '../src/main/oauth2.js';

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

/** A client-credentials configuration against the stub authorization server. */
function clientCredentials(overrides: Partial<OAuth2Auth> = {}): OAuth2Auth {
  return {
    type: 'oauth2',
    grant: 'client-credentials',
    tokenUrl: `${server.url}/oauth2/token`,
    clientId: 'app',
    clientSecretRef: 'sec_client',
    scopes: ['read'],
    clientAuth: 'basic',
    pkce: false,
    ...overrides,
  };
}

/** An authorization-code configuration against the same server. */
function authorizationCode(overrides: Partial<OAuth2Auth> = {}): OAuth2Auth {
  return {
    ...clientCredentials(),
    grant: 'authorization-code',
    authorizationUrl: `${server.url}/oauth2/authorize`,
    pkce: true,
    ...overrides,
  };
}

const credentials = { clientSecret: 's3cret' };

/** A service whose "browser" is a `fetch` that follows the redirect back to the loopback listener. */
function withBrowser(visited: string[] = []): OAuth2Service {
  return new OAuth2Service({
    openExternal: async (url) => {
      visited.push(url);
      await fetch(url, { redirect: 'follow' });
    },
  });
}

/** The first non-loopback IPv4 address of this machine, when it has one. */
function externalAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return undefined;
}

/** Whether a TCP connection to `host:port` is accepted. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

describe('the client-credentials grant', () => {
  it('obtains a token, caches it, and does not ask twice', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });
    const config = clientCredentials();

    const first = await service.accessToken(config, { credentials });
    const second = await service.accessToken(config, { credentials });

    expect(first).toMatch(/^access-/);
    expect(second).toBe(first);
    expect(service.status(config)).toMatchObject({ state: 'valid' });
  });

  it('asks again after the token is forgotten', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });
    const config = clientCredentials();

    const first = await service.accessToken(config, { credentials });
    service.clear(config);
    expect(service.status(config)).toEqual({ state: 'none' });

    expect(await service.accessToken(config, { credentials })).not.toBe(first);
  });

  it('fails loudly when the client secret is wrong, rather than sending no credentials', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });

    await expect(
      service.accessToken(clientCredentials(), { credentials: { clientSecret: 'nope' } }),
    ).rejects.toMatchObject({ code: 'oauth2-token-error' });
  });
});

describe('the authorization-code grant', () => {
  it('runs the browser flow, checks PKCE, and ends with a token', async () => {
    const visited: string[] = [];
    const service = withBrowser(visited);
    const config = authorizationCode();

    const status = await service.fetchToken(config, { credentials });

    expect(status.state).toBe('valid');
    expect(visited[0]).toContain('code_challenge=');
    expect(visited[0]).toContain('code_challenge_method=S256');
    expect(visited[0]).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A');
    expect(await service.accessToken(config, { credentials })).toMatch(/^access-/);
  });

  it('refuses a callback whose state it did not issue, and times out instead of accepting it', async () => {
    const service = new OAuth2Service({
      openExternal: async (url) => {
        // The "browser" answers the loopback listener directly with somebody else's state: an
        // injected code must not become this flow's token.
        const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
        const response = await fetch(`${redirectUri}?code=injected&state=not-ours`);
        expect(response.status).toBe(400);
        // The flow is still waiting, so cancelling it is what ends the test.
        service.cancel();
      },
    });

    await expect(service.fetchToken(authorizationCode(), { credentials })).rejects.toMatchObject({
      code: 'oauth2-cancelled',
    });
    expect(server.issuedTokens.at(-1) ?? '').not.toBe('injected');
  });

  it('reports the provider refusing the sign-in', async () => {
    const service = new OAuth2Service({
      openExternal: async (url) => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
        const state = new URL(url).searchParams.get('state') ?? '';
        await fetch(`${redirectUri}?error=access_denied&state=${state}`);
      },
    });

    await expect(service.fetchToken(authorizationCode(), { credentials })).rejects.toMatchObject({
      code: 'oauth2-authorization-failed',
    });
  });

  it("escapes the provider's error into the callback page rather than rendering it as markup", async () => {
    // The provider (or anyone who can drive the redirect, since it carries the matching state)
    // chooses this string, and it is interpolated into the page the user's own browser renders on
    // the http://127.0.0.1:<port> origin. Unescaped, it is reflected XSS.
    const injection = '</p><script>alert(1)</script><p>';
    let page = '';
    const service = new OAuth2Service({
      openExternal: async (url) => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
        const state = new URL(url).searchParams.get('state') ?? '';
        const response = await fetch(
          `${redirectUri}?error=${encodeURIComponent(injection)}&state=${encodeURIComponent(state)}`,
        );
        page = await response.text();
      },
    });

    await expect(service.fetchToken(authorizationCode(), { credentials })).rejects.toMatchObject({
      code: 'oauth2-authorization-failed',
    });

    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;');
    // The page still says what happened — escaping must not cost the message.
    expect(page).toContain('refused the sign-in');
  });

  it('allows only one pending flow, and says which state it is in', async () => {
    let released: (() => void) | undefined;
    const service = new OAuth2Service({
      openExternal: () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
    });

    const pending = service.fetchToken(authorizationCode(), { credentials });
    // The browser has been opened and nobody has come back yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.status(authorizationCode())).toEqual({ state: 'pending' });

    await expect(service.fetchToken(authorizationCode(), { credentials })).rejects.toMatchObject({
      code: 'oauth2-flow-pending',
    });

    expect(service.cancel()).toEqual({ cancelled: true });
    released?.();
    await expect(pending).rejects.toMatchObject({ code: 'oauth2-cancelled' });
    expect(service.cancel()).toEqual({ cancelled: false });
  });

  it('listens on the loopback address and nowhere else', async () => {
    let port = 0;
    const external = externalAddress();
    const service = new OAuth2Service({
      openExternal: async (url) => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri') ?? '';
        port = Number(new URL(redirectUri).port);
        expect(new URL(redirectUri).hostname).toBe('127.0.0.1');
        expect(await reachable('127.0.0.1', port)).toBe(true);
        if (external !== undefined) {
          expect(await reachable(external, port)).toBe(false);
        }
        service.cancel();
      },
    });

    await expect(service.fetchToken(authorizationCode(), { credentials })).rejects.toMatchObject({
      code: 'oauth2-cancelled',
    });
    expect(port).toBeGreaterThan(0);
    // And the listener is gone once the flow ends, rather than left open for the session.
    expect(await reachable('127.0.0.1', port)).toBe(false);
  });

  it('never opens a browser because a request was sent', async () => {
    const visited: string[] = [];
    const service = withBrowser(visited);

    await expect(service.accessToken(authorizationCode(), { credentials })).rejects.toMatchObject({
      code: 'oauth2-sign-in-required',
    });
    expect(visited).toEqual([]);
  });

  it('refreshes a token near expiry with the refresh token the flow returned', async () => {
    // The stub's tokens last an hour; a clock an hour on makes the cached one due for refresh.
    let now = new Date();
    const service = new OAuth2Service({
      openExternal: async (url) => {
        await fetch(url, { redirect: 'follow' });
      },
      now: () => now,
    });
    const config = authorizationCode();

    await service.fetchToken(config, { credentials });
    const first = await service.accessToken(config, { credentials });
    now = new Date(now.getTime() + 3_600_000);
    expect(service.status(config)).toMatchObject({ state: 'expired' });

    const refreshed = await service.accessToken(config, { credentials });
    expect(refreshed).not.toBe(first);
    expect(server.issuedRefreshTokens.length).toBeGreaterThan(1);
  });

  it('takes a remembered refresh token from the caller when nothing is cached', async () => {
    const browser = withBrowser();
    const config = authorizationCode();
    await browser.fetchToken(config, { credentials });
    const remembered = server.issuedRefreshTokens.at(-1)!;

    // A fresh service: no cache at all, so the only way to a token without a browser is the
    // remembered refresh token.
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });
    const token = await service.accessToken(config, { credentials: { ...credentials, refreshToken: remembered } });

    expect(token).toMatch(/^access-/);
  });

  it('asks to sign in again when the remembered refresh token is no longer good', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });

    await expect(
      service.accessToken(authorizationCode(), { credentials: { ...credentials, refreshToken: 'retired' } }),
    ).rejects.toMatchObject({ code: 'oauth2-sign-in-required' });
  });
});

describe('remembering a refresh token', () => {
  it('is offered one only when the configuration says to remember it', async () => {
    const withRef: string[] = [];
    const service = withBrowser();
    await service.fetchToken(authorizationCode({ refreshTokenRef: 'sec_refresh' }), {
      credentials,
      rememberRefreshToken: async (token) => {
        withRef.push(token);
        await Promise.resolve();
      },
    });
    expect(withRef).toHaveLength(1);

    const without: string[] = [];
    const plain = withBrowser();
    await plain.fetchToken(authorizationCode(), {
      credentials,
      rememberRefreshToken: async (token) => {
        without.push(token);
        await Promise.resolve();
      },
    });
    expect(without).toEqual([]);
  });
});

describe('the status a renderer is shown', () => {
  it('withholds the token itself unless the session says to show secrets', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });
    const config = clientCredentials();
    await service.accessToken(config, { credentials });

    expect(service.status(config).token).toBeUndefined();
    expect(service.status(config, { showSecrets: true }).token).toMatch(/^access-/);
    expect(service.status(config)).toMatchObject({ scopes: ['read'] });
    expect(service.status(config).expiresAt).toMatch(/^\d{4}-/);
  });
});

describe('tokenCacheKey', () => {
  it('is the same for the same configuration and different for a different one', () => {
    const config = clientCredentials();
    expect(tokenCacheKey(config)).toBe(tokenCacheKey({ ...config, scopes: ['read'] }));
    expect(tokenCacheKey(config)).not.toBe(tokenCacheKey({ ...config, clientId: 'other' }));
    expect(tokenCacheKey(config)).not.toBe(tokenCacheKey({ ...config, scopes: ['read', 'write'] }));
    expect(tokenCacheKey(config)).not.toBe(tokenCacheKey({ ...config, audience: 'https://api.test' }));
  });

  it('does not carry the client id or the URL in the clear', () => {
    const key = tokenCacheKey(clientCredentials({ clientId: 'recognisable-client' }));
    expect(key).not.toContain('recognisable-client');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('ignores the order the scopes were configured in', () => {
    const config = clientCredentials({ scopes: ['read', 'write'] });
    expect(tokenCacheKey(config)).toBe(tokenCacheKey({ ...config, scopes: ['write', 'read'] }));
  });
});
