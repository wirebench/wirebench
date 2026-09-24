/**
 * An OpenID provider in a few dozen lines: discovery, JWKS, `/authorize` (answers a code at
 * once, no login page), `/token` (client_secret_post, one use per code) and RS256 ID tokens
 * signed with node:crypto — enough for `openid-client` to really discover, exchange and verify.
 * `nextUser` decides whose claims the next code carries; omit `email` or `email_verified` to
 * test the refusals of spec §3.3.
 */
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeIdpUser {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
}

export interface FakeOidcIssuer {
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Whose claims the next authorization code carries. */
  nextUser(user: FakeIdpUser): void;
  /** Plays the browser: opens the authorization URL and returns the URL the IdP redirects back to. */
  authorize(authorizationUrl: string): Promise<URL>;
  readonly tokenRequests: number;
  close(): Promise<void>;
}

function base64url(value: object | Buffer): string {
  return (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url');
}

function signJwt(payload: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const data = `${base64url({ alg: 'RS256', typ: 'JWT', kid })}.${base64url(payload)}`;
  return `${data}.${base64url(createSign('RSA-SHA256').update(data).sign(privateKey))}`;
}

export async function startFakeOidcIssuer(
  options: { readonly clientId?: string; readonly clientSecret?: string } = {},
): Promise<FakeOidcIssuer> {
  const clientId = options.clientId ?? 'wirebench';
  const clientSecret = options.clientSecret ?? 'client-secret';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fake-idp-key';
  const jwk = publicKey.export({ format: 'jwk' });
  const codes = new Map<string, { user: FakeIdpUser; nonce: string; redirectUri: string }>();
  let pending: FakeIdpUser = { sub: 'sub-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' };
  let tokenRequests = 0;
  let url = '';

  const server = createServer((request, response) => {
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const target = new URL(request.url ?? '/', url);
    if (target.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        jwks_uri: `${url}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
      return;
    }
    if (target.pathname === '/jwks') {
      json(200, { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
      return;
    }
    if (target.pathname === '/authorize') {
      const code = randomBytes(16).toString('hex');
      const redirectUri = target.searchParams.get('redirect_uri') ?? '';
      codes.set(code, { user: pending, nonce: target.searchParams.get('nonce') ?? '', redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', target.searchParams.get('state') ?? '');
      response.writeHead(302, { location: back.href });
      response.end();
      return;
    }
    if (target.pathname === '/token' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        tokenRequests += 1;
        const form = new URLSearchParams(body);
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (
          grant === undefined ||
          form.get('client_id') !== clientId ||
          form.get('client_secret') !== clientSecret ||
          form.get('redirect_uri') !== grant.redirectUri
        ) {
          json(400, { error: 'invalid_grant' });
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt(
          {
            iss: url,
            sub: grant.user.sub,
            aud: clientId,
            exp: now + 300,
            iat: now,
            nonce: grant.nonce,
            ...(grant.user.email !== undefined ? { email: grant.user.email } : {}),
            ...(grant.user.email_verified !== undefined ? { email_verified: grant.user.email_verified } : {}),
            ...(grant.user.name !== undefined ? { name: grant.user.name } : {}),
          },
          privateKey,
          kid,
        );
        json(200, {
          access_token: randomBytes(8).toString('hex'),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    clientId,
    clientSecret,
    nextUser: (user) => {
      pending = user;
    },
    authorize: async (authorizationUrl) => {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status !== 302 || location === null) throw new Error(`authorize answered ${response.status}`);
      return new URL(location);
    },
    get tokenRequests() {
      return tokenRequests;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
