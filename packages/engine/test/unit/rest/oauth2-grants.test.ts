/**
 * The grants and client authentication #338 added: the password and device-code grants, the RFC
 * 7523 client assertions, `tls_client_auth`, and the RFC 8628 device authorization exchange and
 * poll. Everything here is pure or takes its clock, sleep and transport as arguments.
 */
import { X509Certificate, createHash, createHmac, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import type { OAuth2Auth } from '../../../src/project/model.js';
import {
  CLIENT_ASSERTION_TYPE,
  DEVICE_CODE_GRANT_TYPE,
  buildDeviceAuthorizationRequest,
  buildTokenRequest,
  clientAssertion,
  clientAuthSecrets,
  parseDeviceAuthorizationResponse,
  pollDeviceToken,
} from '../../../src/http/auth/oauth2.js';
import { generateClientCert, generateTestCa } from '../../helpers/test-certs.js';

const NOW = new Date('2026-10-12T09:00:00Z');

const base: OAuth2Auth = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'https://id.test/token',
  clientId: 'app',
  scopes: ['read'],
  clientAuth: 'basic',
  pkce: true,
};

function identity(): { readonly cert: string; readonly key: string } {
  const leaf = generateClientCert(generateTestCa());
  return { cert: leaf.certPem, key: leaf.keyPem };
}

function form(request: { readonly body?: Uint8Array }): URLSearchParams {
  return new URLSearchParams(Buffer.from(request.body ?? new Uint8Array()).toString('utf8'));
}

function jwtParts(jwt: string): {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly input: string;
  readonly signature: Buffer;
} {
  const [h = '', c = '', s = ''] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>,
    input: `${h}.${c}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

function json(status: number, body: unknown): HttpExchange {
  return { status, body: new TextEncoder().encode(JSON.stringify(body)) } as unknown as HttpExchange;
}

function code(name: string): unknown {
  return expect.objectContaining({ code: name });
}

describe('password grant', () => {
  it('sends the username, password and scope', () => {
    const request = buildTokenRequest(
      { ...base, grant: 'password', username: 'alice' },
      { clientSecret: 's', password: 'p w+d' },
      { grant: 'password' },
    );
    const body = form(request);
    expect(body.get('grant_type')).toBe('password');
    expect(body.get('username')).toBe('alice');
    expect(body.get('password')).toBe('p w+d');
    expect(body.get('scope')).toBe('read');
    expect(request.headers['Authorization']).toMatch(/^Basic /);
  });

  it('refuses to send without a password or a username', () => {
    expect(() => buildTokenRequest({ ...base, grant: 'password', username: 'a' }, {}, { grant: 'password' })).toThrow(
      code('oauth2-password-missing'),
    );
    expect(() => buildTokenRequest({ ...base, grant: 'password' }, { password: 'p' }, { grant: 'password' })).toThrow(
      code('oauth2-password-missing'),
    );
  });
});

describe('client authentication', () => {
  it('sends a client assertion in the body, never a Basic header', () => {
    const request = buildTokenRequest(
      { ...base, clientAuth: 'client-secret-jwt' },
      { clientSecret: 's', clientAssertion: 'a.b.c' },
      { grant: 'client-credentials' },
    );
    const body = form(request);
    expect(request.headers['Authorization']).toBeUndefined();
    expect(body.get('client_id')).toBe('app');
    expect(body.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE);
    expect(body.get('client_assertion')).toBe('a.b.c');
    expect(body.get('client_secret')).toBeNull();
  });

  it('refuses a JWT method without its assertion', () => {
    expect(() =>
      buildTokenRequest({ ...base, clientAuth: 'private-key-jwt' }, {}, { grant: 'client-credentials' }),
    ).toThrow(code('oauth2-assertion-missing'));
  });

  it('sends only client_id for tls_client_auth, whatever secret is configured', () => {
    const request = buildTokenRequest(
      { ...base, clientAuth: 'tls-client-auth' },
      { clientSecret: 'never' },
      { grant: 'client-credentials' },
    );
    expect(request.headers['Authorization']).toBeUndefined();
    expect(form(request).get('client_id')).toBe('app');
    expect(form(request).get('client_secret')).toBeNull();
  });
});

describe('clientAssertion', () => {
  it('signs client_secret_jwt with HS256 by default and the RFC 7523 claims', () => {
    const jwt = clientAssertion({
      config: { ...base, clientAuth: 'client-secret-jwt' },
      secret: 'shh',
      now: NOW,
      jti: 'j1',
    });
    const { header, claims, input, signature } = jwtParts(jwt);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(claims).toEqual({
      iss: 'app',
      sub: 'app',
      aud: 'https://id.test/token',
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 60,
      jti: 'j1',
    });
    expect(signature.equals(createHmac('sha256', 'shh').update(input).digest())).toBe(true);
  });

  it('honours an HS override and refuses an asymmetric one for a secret', () => {
    const jwt = clientAssertion({
      config: { ...base, clientAuth: 'client-secret-jwt', assertionAlg: 'HS512' },
      secret: 'shh',
      now: NOW,
    });
    expect(jwtParts(jwt).header['alg']).toBe('HS512');
    expect(() =>
      clientAssertion({ config: { ...base, clientAuth: 'client-secret-jwt', assertionAlg: 'RS256' }, secret: 's' }),
    ).toThrow(code('oauth2-assertion-alg'));
    expect(() => clientAssertion({ config: { ...base, clientAuth: 'client-secret-jwt' } })).toThrow(
      code('oauth2-client-secret-missing'),
    );
  });

  it('signs private_key_jwt with the key, picks the algorithm from it, and names the certificate as kid', () => {
    const id = identity();
    const jwt = clientAssertion({ config: { ...base, clientAuth: 'private-key-jwt' }, identity: id, now: NOW });
    const { header, input, signature } = jwtParts(jwt);
    const certificate = new X509Certificate(id.cert);
    expect(header).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: createHash('sha256').update(certificate.raw).digest('base64url'),
    });
    expect(verify('sha256', Buffer.from(input), certificate.publicKey, signature)).toBe(true);
  });

  it('refuses an HS override for a private key, and a missing identity', () => {
    expect(() =>
      clientAssertion({
        config: { ...base, clientAuth: 'private-key-jwt', assertionAlg: 'HS256' },
        identity: identity(),
      }),
    ).toThrow(code('oauth2-assertion-alg'));
    expect(() => clientAssertion({ config: { ...base, clientAuth: 'private-key-jwt' } })).toThrow(
      code('oauth2-client-key-missing'),
    );
  });
});

describe('clientAuthSecrets', () => {
  it('passes the secret through for basic and body, and makes a fresh assertion for the JWT methods', () => {
    expect(clientAuthSecrets(base, { clientSecret: 's' })).toEqual({ clientSecret: 's' });
    const config: OAuth2Auth = { ...base, clientAuth: 'client-secret-jwt' };
    const first = clientAuthSecrets(config, { clientSecret: 's', now: NOW });
    const second = clientAuthSecrets(config, { clientSecret: 's', now: NOW });
    expect(first.clientAssertion).toBeDefined();
    expect(first.clientAssertion).not.toBe(second.clientAssertion);
    expect(clientAuthSecrets({ ...base, clientAuth: 'tls-client-auth' }, { clientSecret: 's' })).toEqual({});
  });
});

describe('device authorization', () => {
  const device: OAuth2Auth = { ...base, grant: 'device-code', deviceAuthorizationUrl: 'https://id.test/device' };

  it('posts the client and scope to the device endpoint', () => {
    const request = buildDeviceAuthorizationRequest({ ...device, clientAuth: 'body' }, { clientSecret: 's' });
    expect(request.url).toBe('https://id.test/device');
    expect(request.method).toBe('POST');
    const body = form(request);
    expect(body.get('client_id')).toBe('app');
    expect(body.get('client_secret')).toBe('s');
    expect(body.get('scope')).toBe('read');
    expect(body.get('grant_type')).toBeNull();
  });

  it('refuses a configuration with no device endpoint', () => {
    expect(() => buildDeviceAuthorizationRequest(base, {})).toThrow(code('oauth2-no-device-authorization-url'));
  });

  it('reads the RFC 8628 §3.2 response, with the default interval', () => {
    const response = parseDeviceAuthorizationResponse({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          device_code: 'GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://example.com/device',
          verification_uri_complete: 'https://example.com/device?user_code=WDJB-MJHT',
          expires_in: 1800,
        }),
      ),
      now: () => NOW,
    });
    expect(response).toEqual({
      deviceCode: 'GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://example.com/device',
      verificationUriComplete: 'https://example.com/device?user_code=WDJB-MJHT',
      expiresAt: new Date(NOW.getTime() + 1_800_000).toISOString(),
      intervalMs: 5000,
    });
  });

  it('accepts the verification_url spelling some providers use, and raises a provider error', () => {
    const response = parseDeviceAuthorizationResponse({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({
          device_code: 'd',
          user_code: 'u',
          verification_url: 'https://g.test/device',
          expires_in: 60,
          interval: 2,
        }),
      ),
      now: () => NOW,
    });
    expect(response.verificationUri).toBe('https://g.test/device');
    expect(response.intervalMs).toBe(2000);
    expect(() =>
      parseDeviceAuthorizationResponse({
        status: 400,
        body: new TextEncoder().encode(JSON.stringify({ error: 'invalid_client' })),
      }),
    ).toThrow(code('oauth2-token-error'));
    expect(() =>
      parseDeviceAuthorizationResponse({
        status: 200,
        body: new TextEncoder().encode(JSON.stringify({ user_code: 'u' })),
      }),
    ).toThrow(code('oauth2-token-malformed'));
  });

  it('builds the device-code token request', () => {
    const body = form(buildTokenRequest(device, {}, { grant: 'device-code', deviceCode: 'dc' }));
    expect(body.get('grant_type')).toBe(DEVICE_CODE_GRANT_TYPE);
    expect(body.get('device_code')).toBe('dc');
    expect(body.get('client_id')).toBe('app');
  });
});

describe('pollDeviceToken', () => {
  function clock(): { now: () => Date; sleep: (ms: number) => Promise<void>; slept: number[] } {
    let at = NOW.getTime();
    const slept: number[] = [];
    return {
      now: () => new Date(at),
      sleep: (ms) => {
        slept.push(ms);
        at += ms;
        return Promise.resolve();
      },
      slept,
    };
  }
  const authorization = {
    deviceCode: 'dc',
    userCode: 'u',
    verificationUri: 'https://id.test/verify',
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    intervalMs: 5000,
  };
  const request = (): HttpRequest => buildTokenRequest(base, {}, { grant: 'device-code', deviceCode: 'dc' });

  it('waits through authorization_pending, slows down on slow_down, and returns the token', async () => {
    const answers = [
      json(400, { error: 'authorization_pending' }),
      json(400, { error: 'slow_down' }),
      json(200, { access_token: 'at', expires_in: 60, refresh_token: 'rt' }),
    ];
    const c = clock();
    let sent = 0;
    const token = await pollDeviceToken({
      authorization,
      request,
      send: () => {
        sent += 1;
        const answer = answers.shift();
        return answer === undefined ? Promise.reject(new Error('asked too often')) : Promise.resolve(answer);
      },
      now: c.now,
      sleep: c.sleep,
    });
    expect(token).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(c.slept).toEqual([5000, 5000, 10000]);
    expect(sent).toBe(3);
  });

  it('stops on access_denied with the provider code', async () => {
    const c = clock();
    const error = await pollDeviceToken({
      authorization,
      request,
      send: () => Promise.resolve(json(400, { error: 'access_denied' })),
      now: c.now,
      sleep: c.sleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WirebenchError);
    expect(error).toMatchObject({ code: 'oauth2-token-error', details: { error: 'access_denied' } });
  });

  it('times out when the code expires, and cancels on abort', async () => {
    const c = clock();
    await expect(
      pollDeviceToken({
        authorization,
        request,
        send: () => Promise.resolve(json(400, { error: 'authorization_pending' })),
        now: c.now,
        sleep: c.sleep,
      }),
    ).rejects.toMatchObject({ code: 'oauth2-timeout' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      pollDeviceToken({
        authorization,
        request,
        send: () => Promise.reject(new Error('unused')),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'oauth2-cancelled' });
  });
});
