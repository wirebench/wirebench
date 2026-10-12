/**
 * Signing a JWT (RFC 7515 compact serialisation, RFC 7518 algorithms) with `node:crypto` alone.
 *
 * Shared by everything that signs a token itself: OAuth2 client assertions (RFC 7523 §2.2, #338)
 * and client-signed bearer tokens (#348). An HMAC key is a secret's text; every other key is a PEM
 * private key, normally a keystore alias's `keyPem`. The key and the algorithm must agree — an
 * HMAC over a PEM, or an RSA signature with an EC key, is refused rather than produced.
 */

import { createHmac, createPrivateKey, constants, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { WirebenchError } from '../../errors.js';

/** The JWS algorithms Wirebench signs with. `none` is deliberately absent. */
export const JWT_ALGS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;
export type JwtAlg = (typeof JWT_ALGS)[number];

export interface SignJwtInput {
  readonly alg: JwtAlg;
  /** The HMAC secret for `HS*`; a PEM private key for every other algorithm. */
  readonly key: string;
  /** Extra header fields, such as `kid`. `alg` and `typ` are always the signer's own. */
  readonly header?: Readonly<Record<string, unknown>>;
  readonly claims: Readonly<Record<string, unknown>>;
}

const HASH: Record<'256' | '384' | '512', string> = { '256': 'sha256', '384': 'sha384', '512': 'sha512' };
/** The curve each ES algorithm requires (RFC 7518 §3.4). */
const CURVE: Record<'256' | '384' | '512', string> = { '256': 'prime256v1', '384': 'secp384r1', '512': 'secp521r1' };

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function mismatch(message: string, alg: JwtAlg): WirebenchError {
  return new WirebenchError('jwt-key-mismatch', message, { details: { alg } });
}

function privateKey(pem: string, alg: JwtAlg): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch (error) {
    throw new WirebenchError('jwt-key-invalid', `${alg} needs a PEM private key, and this key could not be read.`, {
      details: { alg },
      cause: error,
    });
  }
}

/** A compact JWS over `claims`. */
export function signJwt(input: SignJwtInput): string {
  const { alg, key } = input;
  const header = { ...input.header, alg, typ: 'JWT' };
  const signingInput = `${segment(header)}.${segment(input.claims)}`;
  const family = alg.slice(0, 2);
  const bits = alg.slice(2) as '256' | '384' | '512';
  const hash = HASH[bits];

  if (family === 'HS') {
    if (key === '') {
      throw mismatch(`${alg} needs a secret to sign with.`, alg);
    }
    if (key.includes('PRIVATE KEY-----')) {
      throw mismatch(`${alg} signs with a shared secret, not a private key.`, alg);
    }
    return `${signingInput}.${createHmac(hash, key).update(signingInput).digest('base64url')}`;
  }

  const keyObject = privateKey(key, alg);
  const type = keyObject.asymmetricKeyType;
  let signature: Buffer;
  if (family === 'ES') {
    const curve = keyObject.asymmetricKeyDetails?.namedCurve;
    if (type !== 'ec' || curve !== CURVE[bits]) {
      throw mismatch(`${alg} needs an EC key on ${CURVE[bits]}.`, alg);
    }
    signature = sign(hash, Buffer.from(signingInput), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  } else {
    if (type !== 'rsa') {
      throw mismatch(`${alg} needs an RSA key.`, alg);
    }
    signature = sign(
      hash,
      Buffer.from(signingInput),
      family === 'PS'
        ? { key: keyObject, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }
        : keyObject,
    );
  }
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * The algorithm a private key signs with when nobody chose one: RS256 for RSA, the ES size that
 * matches an EC key's curve. Any other key has no JWS algorithm Wirebench offers.
 */
export function defaultAlgFor(keyPem: string): JwtAlg {
  const keyObject = privateKey(keyPem, 'RS256');
  if (keyObject.asymmetricKeyType === 'rsa') {
    return 'RS256';
  }
  if (keyObject.asymmetricKeyType === 'ec') {
    switch (keyObject.asymmetricKeyDetails?.namedCurve) {
      case CURVE['256']:
        return 'ES256';
      case CURVE['384']:
        return 'ES384';
      case CURVE['512']:
        return 'ES512';
    }
  }
  throw new WirebenchError('jwt-key-unsupported', 'Only RSA and P-256/384/521 EC keys can sign a JWT.', {
    details: { keyType: keyObject.asymmetricKeyType ?? 'unknown' },
  });
}
