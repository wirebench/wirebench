/**
 * Client-signed JWTs (#348): the signing, the claim templating and the token reuse every host
 * shares. The OAuth2 `private_key_jwt` client authentication signs through {@link signJwt} too.
 *
 * Pure apart from the clock and the random `jti`, both injectable: the key arrives as a `KeyObject`
 * or HMAC bytes the host already resolved (a keystore entry, a secret), and this module never reads
 * a file or a secret store.
 */

import { createPrivateKey, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import type { JwtAlgorithm } from './jwt-algorithms.js';
import { WirebenchError } from '../../errors.js';
import { expand } from '../../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../../project/properties.js';

export { JWT_ALGORITHMS, isHmacAlgorithm } from './jwt-algorithms.js';
export type { JwtAlgorithm } from './jwt-algorithms.js';

/** A private key, or an HMAC secret's bytes. */
export type JwtSigningKey = KeyObject | Uint8Array;

export type JwtObject = Record<string, unknown>;

export interface SignJwtInput {
  readonly algorithm: JwtAlgorithm;
  readonly key: JwtSigningKey;
  /** Extra protected-header fields (`kid`, `typ`, …). `alg` always comes from `algorithm`. */
  readonly header?: JwtObject;
  readonly claims: JwtObject;
}

/**
 * Signs `claims` as a compact JWS. `typ` defaults to `JWT`.
 *
 * @throws WirebenchError `jwt-key-missing` for an empty HMAC secret, `jwt-key-mismatch` when the key
 * does not suit the algorithm (an EC key for RS256, a P-256 key for ES384, a secret for RS256)
 */
export async function signJwt(input: SignJwtInput): Promise<string> {
  if (input.key instanceof Uint8Array && input.key.length === 0) {
    throw new WirebenchError('jwt-key-missing', 'The JWT secret is empty.', {
      details: { algorithm: input.algorithm },
    });
  }
  if (input.key instanceof Uint8Array && new TextDecoder().decode(input.key).includes('PRIVATE KEY-----')) {
    throw new WirebenchError('jwt-key-mismatch', `${input.algorithm} signs with a shared secret, not a private key.`, {
      details: { algorithm: input.algorithm },
    });
  }
  // `alg` is the configured algorithm's alone: a header field must never downgrade it.
  const header = Object.fromEntries(Object.entries(input.header ?? {}).filter(([name]) => name !== 'alg'));
  try {
    return await new SignJWT(input.claims)
      .setProtectedHeader({ typ: 'JWT', ...header, alg: input.algorithm })
      .sign(input.key);
  } catch (error) {
    throw new WirebenchError(
      'jwt-key-mismatch',
      `The key cannot sign ${input.algorithm}: ${error instanceof Error ? error.message : String(error)}`,
      { details: { algorithm: input.algorithm }, cause: error },
    );
  }
}

/** The curve each ES algorithm signs on (RFC 7518 §3.4), as `node:crypto` names it. */
const ES_CURVES: Readonly<Record<string, JwtAlgorithm>> = {
  prime256v1: 'ES256',
  secp384r1: 'ES384',
  secp521r1: 'ES512',
};

/**
 * A PEM private key as a `KeyObject`.
 *
 * @throws WirebenchError `jwt-key-invalid` when the text is not a private key `node:crypto` reads
 */
export function privateKeyOf(pem: string, algorithm: JwtAlgorithm): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch (error) {
    throw new WirebenchError(
      'jwt-key-invalid',
      `${algorithm} needs a PEM private key, and this key could not be read.`,
      {
        details: { algorithm },
        cause: error,
      },
    );
  }
}

/**
 * The algorithm a private key signs with when nobody chose one: RS256 for RSA, the ES size that
 * matches an EC key's curve.
 *
 * @throws WirebenchError `jwt-key-invalid` for unreadable PEM text, `jwt-key-unsupported` for any
 * other key type
 */
export function defaultAlgFor(key: KeyObject | string): JwtAlgorithm {
  const keyObject = typeof key === 'string' ? privateKeyOf(key, 'RS256') : key;
  if (keyObject.asymmetricKeyType === 'rsa') return 'RS256';
  const curve = keyObject.asymmetricKeyDetails?.namedCurve;
  const es = keyObject.asymmetricKeyType === 'ec' && curve !== undefined ? ES_CURVES[curve] : undefined;
  if (es !== undefined) return es;
  throw new WirebenchError('jwt-key-unsupported', 'Only RSA and P-256/384/521 EC keys can sign a JWT.', {
    details: { keyType: keyObject.asymmetricKeyType ?? 'unknown' },
  });
}

/** Claims whose value is a NumericDate (RFC 7519 §2), which a lone `${…}` may fill with a number. */
const NUMERIC_DATE_CLAIMS = new Set(['exp', 'nbf', 'iat']);
const LONE_REFERENCE = /^\$\{[^{}]+\}$/u;
const INTEGER = /^-?\d+$/u;

/** {@link templateJwtJson}'s answer: the object, and the references nothing resolved. */
export interface TemplatedJwtJson {
  readonly value: JwtObject;
  readonly unresolved: readonly UnresolvedRef[];
}

/**
 * Parses a JWT's claims or header text as a JSON object, then expands every string value against
 * `scopes`. Expanding values after parsing means a value holding a quote cannot break the JSON. A
 * string that is exactly one `${…}` under `exp`, `nbf` or `iat` becomes a number when it expands
 * to an integer, so a NumericDate can come from a property. Blank text is an empty object.
 *
 * @throws WirebenchError `jwt-claims-invalid` | `jwt-header-invalid` when the text is not a JSON object
 */
export function templateJwtJson(text: string, scopes: PropertyScopes, part: 'claims' | 'header'): TemplatedJwtJson {
  if (text.trim() === '') {
    return { value: {}, unresolved: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw notAnObject(part, error);
  }
  if (!isObject(parsed)) {
    throw notAnObject(part);
  }
  const unresolved: UnresolvedRef[] = [];
  const walk = (value: unknown, key: string | undefined, top: boolean): unknown => {
    if (typeof value === 'string') {
      const result = expand(value, scopes);
      unresolved.push(...result.unresolved);
      const numeric =
        top &&
        key !== undefined &&
        NUMERIC_DATE_CLAIMS.has(key) &&
        LONE_REFERENCE.test(value) &&
        INTEGER.test(result.text);
      return numeric ? Number(result.text) : result.text;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, undefined, false));
    }
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name, false)]));
    }
    return value;
  };
  const value = Object.fromEntries(Object.entries(parsed).map(([name, item]) => [name, walk(item, name, true)]));
  return { value, unresolved };
}

function isObject(value: unknown): value is JwtObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notAnObject(part: 'claims' | 'header', cause?: unknown): WirebenchError {
  return new WirebenchError(
    part === 'claims' ? 'jwt-claims-invalid' : 'jwt-header-invalid',
    `The JWT ${part} must be a JSON object.`,
    cause === undefined ? undefined : { cause },
  );
}

/** One token a send needs: what to sign, with what, and which claims to generate. */
export interface JwtTokenRequest {
  readonly algorithm: JwtAlgorithm;
  /**
   * What names the key without holding it (a secret ref, a keystore id and alias): part of the
   * reuse key, so a token is never reused across keys.
   */
  readonly keyIdentity: string;
  /** Loads the key; called only when a token is actually signed. */
  readonly key: () => Promise<JwtSigningKey>;
  readonly header: JwtObject;
  /** The templated claims, before `iat`, `exp` and `jti` are generated. */
  readonly claims: JwtObject;
  readonly issuedAt: boolean;
  /** `exp` = now + this many seconds; absent or 0 generates none. */
  readonly expiresInSeconds?: number;
  readonly jwtId: boolean;
}

export interface JwtSource {
  /**
   * A token for `request`: the one signed earlier for the same algorithm, key, header and claims
   * while it is more than {@link JWT_REUSE_MARGIN_SECONDS} from its `exp`, else a new one. A token
   * without `exp` is signed on every call: nothing says when it goes stale.
   *
   * @throws WirebenchError from {@link signJwt}, or whatever loading the key throws
   */
  tokenFor(request: JwtTokenRequest): Promise<string>;
  /** Drops a token a server refused, so the next call signs a new one. */
  reject(token: string): void;
}

/** How long before its `exp` a token stops being reused, so it never expires in flight. */
export const JWT_REUSE_MARGIN_SECONDS = 30;

export interface JwtSourceOptions {
  readonly now?: () => Date;
  /** The generated `jti`. A random UUID by default. */
  readonly randomId?: () => string;
}

interface CachedJwt {
  readonly token: string;
  /** Seconds since the epoch. */
  readonly exp: number;
}

export function createJwtSource(options: JwtSourceOptions = {}): JwtSource {
  const now = options.now ?? ((): Date => new Date());
  const randomId = options.randomId ?? randomUUID;
  const tokens = new Map<string, CachedJwt>();
  return {
    async tokenFor(request) {
      const key = JSON.stringify([
        request.algorithm,
        request.keyIdentity,
        request.header,
        request.claims,
        request.issuedAt,
        request.expiresInSeconds ?? 0,
        request.jwtId,
      ]);
      const seconds = Math.floor(now().getTime() / 1000);
      const cached = tokens.get(key);
      if (cached !== undefined && seconds < cached.exp - JWT_REUSE_MARGIN_SECONDS) {
        return cached.token;
      }
      const claims: JwtObject = { ...request.claims };
      if (request.issuedAt) claims.iat = seconds;
      if (request.expiresInSeconds !== undefined && request.expiresInSeconds > 0) {
        claims.exp = seconds + request.expiresInSeconds;
      }
      if (request.jwtId) claims.jti = randomId();
      const token = await signJwt({
        algorithm: request.algorithm,
        key: await request.key(),
        header: request.header,
        claims,
      });
      if (typeof claims.exp === 'number') {
        tokens.set(key, { token, exp: claims.exp });
      } else {
        tokens.delete(key);
      }
      return token;
    },
    reject(token) {
      for (const [key, cached] of tokens) {
        if (cached.token === token) tokens.delete(key);
      }
    },
  };
}
