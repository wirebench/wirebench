import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  JWT_ALGORITHMS,
  createJwtSource,
  defaultAlgFor,
  isHmacAlgorithm,
  privateKeyOf,
  signJwt,
  templateJwtJson,
} from '../../../../src/http/auth/jwt.js';
import type { JwtAlgorithm, JwtTokenRequest } from '../../../../src/http/auth/jwt.js';
import type { PropertyScopes } from '../../../../src/project/properties.js';

const SECRET = new TextEncoder().encode('a-shared-secret-that-is-long-enough-for-hs512-signing-0123456789');

function keyPairFor(algorithm: JwtAlgorithm): { privateKey: KeyObject; publicKey: KeyObject } {
  if (algorithm.startsWith('ES')) {
    const namedCurve = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }[algorithm as 'ES256'];
    return generateKeyPairSync('ec', { namedCurve });
  }
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

const scopes = (env: Record<string, string> = {}): PropertyScopes => ({ project: {}, env, global: {}, system: {} });

describe('signJwt', () => {
  it.each(JWT_ALGORITHMS)('signs and verifies with %s', async (algorithm) => {
    const pair = isHmacAlgorithm(algorithm) ? undefined : keyPairFor(algorithm);
    const token = await signJwt({ algorithm, key: pair?.privateKey ?? SECRET, claims: { sub: 'svc' } });
    const { payload, protectedHeader } = await jwtVerify(token, pair?.publicKey ?? SECRET, {
      algorithms: [algorithm],
    });
    expect(payload.sub).toBe('svc');
    expect(protectedHeader).toEqual({ alg: algorithm, typ: 'JWT' });
  });

  it('keeps extra header fields but never lets them override alg', async () => {
    const token = await signJwt({ algorithm: 'HS256', key: SECRET, header: { kid: 'k1', alg: 'none' }, claims: {} });
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'k1' });
  });

  it('refuses a key of the wrong type or curve as jwt-key-mismatch', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    await expect(signJwt({ algorithm: 'RS256', key: ec, claims: {} })).rejects.toMatchObject({
      code: 'jwt-key-mismatch',
    });
    await expect(signJwt({ algorithm: 'ES384', key: ec, claims: {} })).rejects.toMatchObject({
      code: 'jwt-key-mismatch',
    });
    await expect(signJwt({ algorithm: 'RS256', key: SECRET, claims: {} })).rejects.toMatchObject({
      code: 'jwt-key-mismatch',
    });
  });

  it('refuses an empty HMAC secret as jwt-key-missing', async () => {
    await expect(signJwt({ algorithm: 'HS256', key: new Uint8Array(), claims: {} })).rejects.toMatchObject({
      code: 'jwt-key-missing',
    });
  });
});

describe('templateJwtJson', () => {
  it('expands string values after parsing, so a quote cannot break the JSON', () => {
    const result = templateJwtJson(
      '{"sub":"${name}","nested":{"aud":["${aud}"]},"n":1}',
      scopes({ name: 'a"b', aud: 'x' }),
      'claims',
    );
    expect(result.value).toEqual({ sub: 'a"b', nested: { aud: ['x'] }, n: 1 });
    expect(result.unresolved).toEqual([]);
  });

  it('turns a lone reference under exp, nbf or iat into a number when it expands to an integer', () => {
    const result = templateJwtJson(
      '{"exp":"${t}","nbf":"${t}","other":"${t}","iat":"x${t}"}',
      scopes({ t: '1700000000' }),
      'claims',
    );
    expect(result.value).toEqual({ exp: 1700000000, nbf: 1700000000, other: '1700000000', iat: 'x1700000000' });
  });

  it('reports unresolved references', () => {
    const result = templateJwtJson('{"sub":"${missing}"}', scopes(), 'claims');
    expect(result.unresolved.map((ref) => ref.expr)).toEqual(['${missing}']);
  });

  it('treats empty text as an empty object', () => {
    expect(templateJwtJson('  ', scopes(), 'header').value).toEqual({});
  });

  it('refuses text that is not a JSON object', () => {
    expect(() => templateJwtJson('[1]', scopes(), 'claims')).toThrow(
      expect.objectContaining({ code: 'jwt-claims-invalid' }),
    );
    expect(() => templateJwtJson('{', scopes(), 'header')).toThrow(
      expect.objectContaining({ code: 'jwt-header-invalid' }),
    );
  });
});

describe('createJwtSource', () => {
  function request(overrides: Partial<JwtTokenRequest> = {}): JwtTokenRequest {
    return {
      algorithm: 'HS256',
      keyIdentity: 'sec_1',
      key: () => Promise.resolve(SECRET),
      header: {},
      claims: { sub: 'svc' },
      issuedAt: true,
      expiresInSeconds: 300,
      jwtId: true,
      ...overrides,
    };
  }

  it('generates iat, exp and jti, overwriting claims of the same name', async () => {
    const source = createJwtSource({ now: () => new Date(1_700_000_000_500), randomId: () => 'id-1' });
    const token = await source.tokenFor(request({ claims: { sub: 'svc', iat: 1, jti: 'mine' } }));
    expect(decodeJwt(token)).toEqual({ sub: 'svc', iat: 1_700_000_000, exp: 1_700_000_300, jti: 'id-1' });
  });

  it('leaves out what is not asked for', async () => {
    const source = createJwtSource();
    const token = await source.tokenFor(request({ issuedAt: false, jwtId: false, expiresInSeconds: 0 }));
    expect(decodeJwt(token)).toEqual({ sub: 'svc' });
  });

  it('reuses a token until 30 seconds before it expires, then signs a new one', async () => {
    let now = 1_700_000_000_000;
    let ids = 0;
    const source = createJwtSource({ now: () => new Date(now), randomId: () => `id-${++ids}` });
    const first = await source.tokenFor(request());
    now += 200_000;
    expect(await source.tokenFor(request())).toBe(first);
    now += 75_000; // 25 s before exp
    const second = await source.tokenFor(request());
    expect(second).not.toBe(first);
  });

  it('signs a token with no exp on every send', async () => {
    let ids = 0;
    const source = createJwtSource({ randomId: () => `id-${++ids}` });
    const one = await source.tokenFor(request({ expiresInSeconds: 0 }));
    expect(await source.tokenFor(request({ expiresInSeconds: 0 }))).not.toBe(one);
  });

  it('reuses a token whose exp is written in the claims', async () => {
    const now = 1_700_000_000_000;
    const source = createJwtSource({ now: () => new Date(now) });
    const claims = { sub: 'svc', exp: 1_700_000_600 };
    const one = await source.tokenFor(request({ expiresInSeconds: 0, claims }));
    expect(await source.tokenFor(request({ expiresInSeconds: 0, claims }))).toBe(one);
  });

  it('signs anew when a claim, the header, the key or the algorithm changes', async () => {
    const source = createJwtSource();
    const base = await source.tokenFor(request());
    for (const changed of [
      request({ claims: { sub: 'other' } }),
      request({ header: { kid: 'k2' } }),
      request({ keyIdentity: 'sec_2' }),
      request({ algorithm: 'HS384' }),
    ]) {
      expect(await source.tokenFor(changed)).not.toBe(base);
    }
  });

  it('drops a refused token so the next send signs a new one', async () => {
    let ids = 0;
    const source = createJwtSource({ randomId: () => `id-${++ids}` });
    const first = await source.tokenFor(request());
    source.reject(first);
    expect(await source.tokenFor(request())).not.toBe(first);
  });

  it('loads the key only when it signs', async () => {
    let loads = 0;
    const source = createJwtSource();
    const key = (): Promise<Uint8Array> => {
      loads += 1;
      return Promise.resolve(SECRET);
    };
    await source.tokenFor(request({ key }));
    await source.tokenFor(request({ key }));
    expect(loads).toBe(1);
  });
});

describe('defaultAlgFor and privateKeyOf', () => {
  const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('picks RS256 for RSA and the ES size by curve, from PEM text or a KeyObject', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(defaultAlgFor(pem(rsa))).toBe('RS256');
    expect(defaultAlgFor(rsa)).toBe('RS256');
    for (const [namedCurve, algorithm] of [
      ['P-256', 'ES256'],
      ['P-384', 'ES384'],
      ['P-521', 'ES512'],
    ] as const) {
      expect(defaultAlgFor(pem(generateKeyPairSync('ec', { namedCurve }).privateKey))).toBe(algorithm);
    }
  });

  it('refuses a key type JWS has no algorithm for, and text that is not a key', () => {
    const ed = generateKeyPairSync('ed25519').privateKey;
    expect(() => defaultAlgFor(pem(ed))).toThrow(expect.objectContaining({ code: 'jwt-key-unsupported' }));
    expect(() => privateKeyOf('plain secret', 'RS256')).toThrow(expect.objectContaining({ code: 'jwt-key-invalid' }));
  });

  it('refuses a private key offered as an HMAC secret', async () => {
    const rsa = pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
    await expect(signJwt({ algorithm: 'HS256', key: new TextEncoder().encode(rsa), claims: {} })).rejects.toMatchObject(
      { code: 'jwt-key-mismatch' },
    );
  });
});
