/**
 * The pure half of OAuth2: PKCE, the authorization URL, the token request per grant, and reading a
 * token response.
 *
 * The PKCE vectors are RFC 7636's own (appendix B), because a challenge computed even slightly
 * differently fails at the provider with a message that explains nothing. The token-request goldens
 * exist for the same reason: `clientAuth` in the wrong place is the single most common reason a
 * client-credentials flow is refused.
 */
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import type { OAuth2Auth } from '../../../src/project/model.js';
import {
  TOKEN_REFRESH_MARGIN_MS,
  authorizationUrl,
  buildTokenRequest,
  needsRefresh,
  newState,
  parseTokenResponse,
  pkce,
} from '../../../src/rest/oauth2.js';

const NOW = new Date('2026-09-13T12:00:00Z');

const config: OAuth2Auth = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'https://id.test/token',
  authorizationUrl: 'https://id.test/authorize',
  clientId: 'app',
  scopes: ['read', 'write'],
  clientAuth: 'basic',
  pkce: true,
};

function form(request: { readonly body?: Uint8Array }): URLSearchParams {
  return new URLSearchParams(Buffer.from(request.body ?? new Uint8Array()).toString('utf8'));
}

describe('pkce', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    // The appendix's verifier is the base64url of these 32 bytes.
    const octets = Uint8Array.from([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
      91, 88, 5, 88, 83, 132, 141, 121,
    ]);
    const pair = pkce(() => octets);
    expect(pair.verifier).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(pair.challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pair.method).toBe('S256');
  });

  it('produces a 43-character base64url verifier with no padding', () => {
    const pair = pkce();
    expect(pair.verifier).toHaveLength(43);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce().verifier).not.toBe(pair.verifier);
  });

  it('makes a state value that is url-safe and unguessable', () => {
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newState()).not.toBe(newState());
  });
});

describe('authorizationUrl', () => {
  it('carries the response type, client, redirect, state, scope and challenge', () => {
    const url = new URL(
      authorizationUrl({ config, redirectUri: 'http://127.0.0.1:7777/callback', state: 'st', challenge: 'ch' }),
    );
    expect(url.origin + url.pathname).toBe('https://id.test/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'app',
      redirect_uri: 'http://127.0.0.1:7777/callback',
      state: 'st',
      scope: 'read write',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('omits the challenge when PKCE is switched off', () => {
    const url = new URL(
      authorizationUrl({
        config: { ...config, pkce: false },
        redirectUri: 'http://127.0.0.1/cb',
        state: 's',
        challenge: 'ch',
      }),
    );
    expect(url.searchParams.has('code_challenge')).toBe(false);
  });

  it('includes an audience when one is configured', () => {
    const url = new URL(
      authorizationUrl({
        config: { ...config, audience: 'https://api' },
        redirectUri: 'http://127.0.0.1/cb',
        state: 's',
      }),
    );
    expect(url.searchParams.get('audience')).toBe('https://api');
  });

  it('refuses a configuration with no authorization endpoint', () => {
    expect(() =>
      authorizationUrl({ config: { ...config, authorizationUrl: '' }, redirectUri: 'x', state: 's' }),
    ).toThrow(WirebenchError);
  });
});

describe('buildTokenRequest', () => {
  it('puts client credentials in a Basic header for a confidential client', () => {
    const request = buildTokenRequest(config, { clientSecret: 's3cret' }, { grant: 'client-credentials' });

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://id.test/token');
    expect(request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(request.headers.Authorization).toBe(`Basic ${Buffer.from('app:s3cret').toString('base64')}`);
    expect(Object.fromEntries(form(request))).toEqual({ grant_type: 'client_credentials', scope: 'read write' });
  });

  it('form-urlencodes both halves of the Basic credential', () => {
    const request = buildTokenRequest(
      { ...config, clientId: 'a b' },
      { clientSecret: 'p+q' },
      { grant: 'client-credentials' },
    );
    expect(request.headers.Authorization).toBe(`Basic ${Buffer.from('a%20b:p%2Bq').toString('base64')}`);
  });

  it('puts them in the body when clientAuth says body', () => {
    const request = buildTokenRequest(
      { ...config, clientAuth: 'body' },
      { clientSecret: 's3cret' },
      { grant: 'client-credentials' },
    );
    expect(request.headers.Authorization).toBeUndefined();
    expect(Object.fromEntries(form(request))).toMatchObject({ client_id: 'app', client_secret: 's3cret' });
  });

  it('sends only client_id for a public client with no secret', () => {
    const request = buildTokenRequest(config, {}, { grant: 'client-credentials' });
    expect(request.headers.Authorization).toBeUndefined();
    expect(form(request).get('client_id')).toBe('app');
    expect(form(request).has('client_secret')).toBe(false);
  });

  it('exchanges an authorization code with its verifier and redirect', () => {
    const request = buildTokenRequest(
      { ...config, grant: 'authorization-code' },
      { clientSecret: 's' },
      { grant: 'authorization-code', code: 'CODE', redirectUri: 'http://127.0.0.1:7/cb', verifier: 'VER' },
    );
    expect(Object.fromEntries(form(request))).toEqual({
      grant_type: 'authorization_code',
      code: 'CODE',
      redirect_uri: 'http://127.0.0.1:7/cb',
      code_verifier: 'VER',
    });
  });

  it('refreshes with the refresh token and the configured scopes', () => {
    const request = buildTokenRequest(config, { clientSecret: 's' }, { grant: 'refresh', refreshToken: 'RT' });
    expect(Object.fromEntries(form(request))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'RT',
      scope: 'read write',
    });
  });

  it('never follows a redirect from the token endpoint', () => {
    expect(buildTokenRequest(config, {}, { grant: 'client-credentials' }).followRedirects).toBe(false);
  });

  it('refuses a configuration with no token endpoint', () => {
    expect(() => buildTokenRequest({ ...config, tokenUrl: '' }, {}, { grant: 'client-credentials' })).toThrow(
      /no token URL/,
    );
  });
});

describe('parseTokenResponse', () => {
  const body = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it('reads the RFC 6749 example response and makes the expiry absolute', () => {
    expect(
      parseTokenResponse({
        status: 200,
        now: () => NOW,
        body: body({
          access_token: '2YotnFZFEjr1zCsicMWpAA',
          token_type: 'example',
          expires_in: 3600,
          refresh_token: 'tGzv3JOkF0XG5Qx2TlKWIA',
          scope: 'read write',
        }),
      }),
    ).toEqual({
      accessToken: '2YotnFZFEjr1zCsicMWpAA',
      tokenType: 'example',
      expiresAt: '2026-09-13T13:00:00.000Z',
      refreshToken: 'tGzv3JOkF0XG5Qx2TlKWIA',
      scopes: ['read', 'write'],
    });
  });

  it('defaults the token type and tolerates a missing expiry', () => {
    expect(parseTokenResponse({ status: 200, body: body({ access_token: 'a' }) })).toEqual({
      accessToken: 'a',
      tokenType: 'Bearer',
    });
  });

  it('accepts expires_in sent as a string, which some providers do', () => {
    expect(
      parseTokenResponse({ status: 200, now: () => NOW, body: body({ access_token: 'a', expires_in: '60' }) })
        .expiresAt,
    ).toBe('2026-09-13T12:01:00.000Z');
  });

  it('raises the provider error, with its description', () => {
    const error = (() => {
      try {
        parseTokenResponse({
          status: 400,
          body: body({ error: 'invalid_client', error_description: 'Client authentication failed' }),
        });
      } catch (e) {
        return e as WirebenchError;
      }
      return undefined;
    })();
    expect(error?.code).toBe('oauth2-token-error');
    expect(error?.message).toBe('Client authentication failed');
    expect(error?.details).toMatchObject({ error: 'invalid_client', status: 400 });
  });

  it('believes an error in a 200 body over the status', () => {
    expect(() => parseTokenResponse({ status: 200, body: body({ error: 'invalid_scope' }) })).toThrow(/invalid_scope/);
  });

  it('refuses a response that is not JSON, or carries no token', () => {
    expect(() => parseTokenResponse({ status: 200, body: new TextEncoder().encode('<html>') })).toThrow(
      /did not answer with JSON/,
    );
    expect(() => parseTokenResponse({ status: 200, body: body({ token_type: 'Bearer' }) })).toThrow(/no access token/);
    expect(() => parseTokenResponse({ status: 200, body: body([1, 2]) })).toThrow(/no access token/);
  });
});

describe('needsRefresh', () => {
  it('is true inside the margin and false outside it', () => {
    const soon = new Date(NOW.getTime() + TOKEN_REFRESH_MARGIN_MS - 1).toISOString();
    const later = new Date(NOW.getTime() + TOKEN_REFRESH_MARGIN_MS + 60_000).toISOString();
    expect(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: soon }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: later }, NOW)).toBe(false);
  });

  it('uses a token with no stated expiry until it fails', () => {
    expect(needsRefresh({ accessToken: 'a', tokenType: 'Bearer' }, NOW)).toBe(false);
  });

  it('ignores an expiry it cannot read rather than refreshing forever', () => {
    expect(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: 'whenever' }, NOW)).toBe(false);
  });
});
