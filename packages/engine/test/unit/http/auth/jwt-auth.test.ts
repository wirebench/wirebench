import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { jwtSendAuth, signConfiguredJwt } from '../../../../src/http/auth/jwt-auth.js';
import type { JwtAuthDeps } from '../../../../src/http/auth/jwt-auth.js';
import { createJwtSource } from '../../../../src/http/auth/jwt.js';
import { loadKeystore } from '../../../../src/keystore/index.js';
import type { JwtAuth } from '../../../../src/project/model.js';

const SECRET = 'a-shared-secret-that-is-long-enough-0123456789';

function config(overrides: Partial<JwtAuth> = {}): JwtAuth {
  return {
    type: 'jwt',
    algorithm: 'HS256',
    secretRef: 'sec_jwt',
    claims: '{"iss":"${issuer}","sub":"svc"}',
    issuedAt: true,
    expiresInSeconds: 300,
    jwtId: false,
    in: 'header',
    ...overrides,
  };
}

function deps(overrides: Partial<JwtAuthDeps> = {}): JwtAuthDeps {
  return {
    scopes: { project: {}, env: { issuer: 'wirebench' }, global: {}, system: {} },
    getSecret: (ref) => Promise.resolve(ref === 'sec_jwt' ? SECRET : undefined),
    keystore: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe('jwtSendAuth', () => {
  it('defaults to an Authorization header with a Bearer prefix', () => {
    expect(jwtSendAuth(config(), 't')).toEqual({
      type: 'jwt',
      token: 't',
      in: 'header',
      name: 'Authorization',
      prefix: 'Bearer',
    });
  });

  it('keeps an empty prefix and a custom header name', () => {
    expect(jwtSendAuth(config({ name: 'X-Token', prefix: '' }), 't')).toMatchObject({ name: 'X-Token', prefix: '' });
  });

  it('defaults the query parameter to access_token', () => {
    expect(jwtSendAuth(config({ in: 'query' }), 't')).toMatchObject({ in: 'query', name: 'access_token' });
  });
});

describe('signConfiguredJwt', () => {
  it('signs with the HMAC secret behind secretRef, expanding the claims', async () => {
    const auth = await signConfiguredJwt(config(), deps(), createJwtSource());
    const { payload } = await jwtVerify(auth.token, new TextEncoder().encode(SECRET));
    expect(payload).toMatchObject({ iss: 'wirebench', sub: 'svc' });
    expect(typeof payload.exp).toBe('number');
  });

  it('signs with the private key of a keystore entry, falling back to its default alias', async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keystore = loadKeystore(new TextEncoder().encode(pem), { type: 'pem' });
    const asked: string[] = [];
    const auth = await signConfiguredJwt(
      config({ algorithm: 'ES256', keystoreRef: 'ks1', header: '{"kid":"${issuer}-1"}' }),
      deps({
        keystore: (id) => {
          asked.push(id);
          return Promise.resolve({ keystore, defaultAlias: 'key-0' });
        },
      }),
      createJwtSource(),
    );
    await jwtVerify(auth.token, pair.publicKey);
    expect(decodeProtectedHeader(auth.token)).toMatchObject({ alg: 'ES256', kid: 'wirebench-1' });
    expect(asked).toEqual(['ks1']);
  });

  it('refuses a configuration with no secret or no keystore as jwt-key-missing', async () => {
    await expect(signConfiguredJwt(config({ secretRef: '' }), deps(), createJwtSource())).rejects.toMatchObject({
      code: 'jwt-key-missing',
    });
    await expect(signConfiguredJwt(config({ algorithm: 'RS256' }), deps(), createJwtSource())).rejects.toMatchObject({
      code: 'jwt-key-missing',
    });
    await expect(
      signConfiguredJwt(config({ algorithm: 'RS256', keystoreRef: 'gone' }), deps(), createJwtSource()),
    ).rejects.toMatchObject({ code: 'jwt-key-missing' });
  });

  it('refuses a secret the store does not hold as secret-missing', async () => {
    await expect(
      signConfiguredJwt(config({ secretRef: 'sec_other' }), deps(), createJwtSource()),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });

  it('refuses unresolved references in the claims or the header', async () => {
    await expect(
      signConfiguredJwt(config({ claims: '{"sub":"${nobody}"}' }), deps(), createJwtSource()),
    ).rejects.toMatchObject({ code: 'unresolved-properties' });
    await expect(
      signConfiguredJwt(config({ header: '{"kid":"${nobody}"}' }), deps(), createJwtSource()),
    ).rejects.toMatchObject({ code: 'unresolved-properties' });
  });

  it('reuses the token while it is fresh', async () => {
    const source = createJwtSource();
    const one = await signConfiguredJwt(config({ jwtId: true }), deps(), source);
    const two = await signConfiguredJwt(config({ jwtId: true }), deps(), source);
    expect(two.token).toBe(one.token);
    expect(decodeJwt(one.token).jti).toBeTypeOf('string');
  });
});
