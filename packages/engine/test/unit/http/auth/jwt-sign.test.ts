import { createHmac, constants, generateKeyPairSync, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultAlgFor, signJwt } from '../../../../src/http/auth/jwt-sign.js';
import type { JwtAlg } from '../../../../src/http/auth/jwt-sign.js';

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
function ec(namedCurve: string): { readonly pem: string; readonly publicKey: KeyObject } {
  const pair = generateKeyPairSync('ec', { namedCurve });
  return { pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: pair.publicKey };
}
const p256 = ec('P-256');
const p384 = ec('P-384');
const p521 = ec('P-521');

function parts(jwt: string): { readonly input: Buffer; readonly signature: Buffer; readonly header: string } {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  return { input: Buffer.from(`${header}.${payload}`), signature: Buffer.from(signature, 'base64url'), header };
}

describe('signJwt', () => {
  it('signs HS256/384/512 with the secret as the HMAC key', () => {
    for (const [alg, hash] of [
      ['HS256', 'sha256'],
      ['HS384', 'sha384'],
      ['HS512', 'sha512'],
    ] as const) {
      const jwt = signJwt({ alg, key: 'shh', claims: { sub: 'a' } });
      const [header = '', payload = ''] = jwt.split('.');
      expect(decode(header)).toEqual({ alg, typ: 'JWT' });
      expect(decode(payload)).toEqual({ sub: 'a' });
      expect(parts(jwt).signature.equals(createHmac(hash, 'shh').update(`${header}.${payload}`).digest())).toBe(true);
    }
  });

  it('signs RS and PS with an RSA key', () => {
    const cases: readonly (readonly [JwtAlg, string, boolean])[] = [
      ['RS256', 'sha256', false],
      ['RS384', 'sha384', false],
      ['RS512', 'sha512', false],
      ['PS256', 'sha256', true],
      ['PS384', 'sha384', true],
      ['PS512', 'sha512', true],
    ];
    for (const [alg, hash, pss] of cases) {
      const { input, signature } = parts(signJwt({ alg, key: rsaPem, claims: { n: 1 } }));
      const key = pss
        ? { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
        : rsa.publicKey;
      expect(verify(hash, input, key, signature), alg).toBe(true);
    }
  });

  it('signs ES in the JOSE r||s form', () => {
    for (const [alg, key, hash, size] of [
      ['ES256', p256, 'sha256', 64],
      ['ES384', p384, 'sha384', 96],
      ['ES512', p521, 'sha512', 132],
    ] as const) {
      const { input, signature } = parts(signJwt({ alg, key: key.pem, claims: {} }));
      expect(signature.length).toBe(size);
      expect(verify(hash, input, { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
    }
  });

  it('merges extra header fields but keeps alg authoritative', () => {
    const { header } = parts(signJwt({ alg: 'HS256', key: 'k', header: { kid: 'one', alg: 'none' }, claims: {} }));
    expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'one' });
  });

  it('refuses a key that does not fit the algorithm', () => {
    expect(() => signJwt({ alg: 'HS256', key: rsaPem, claims: {} })).toThrow(/private key/);
    expect(() => signJwt({ alg: 'HS256', key: '', claims: {} })).toThrow();
    expect(() => signJwt({ alg: 'RS256', key: 'plain secret', claims: {} })).toThrow();
    expect(() => signJwt({ alg: 'ES256', key: rsaPem, claims: {} })).toThrow();
    expect(() => signJwt({ alg: 'ES384', key: p256.pem, claims: {} })).toThrow();
    expect(() => signJwt({ alg: 'RS256', key: p256.pem, claims: {} })).toThrow();
  });
});

describe('defaultAlgFor', () => {
  it('picks RS256 for RSA and ES by curve', () => {
    expect(defaultAlgFor(rsaPem)).toBe('RS256');
    expect(defaultAlgFor(p256.pem)).toBe('ES256');
    expect(defaultAlgFor(p384.pem)).toBe('ES384');
    expect(defaultAlgFor(p521.pem)).toBe('ES512');
  });

  it('refuses keys JWS has no algorithm for', () => {
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => defaultAlgFor(ed)).toThrow();
  });
});
