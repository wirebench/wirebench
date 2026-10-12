/**
 * A configured {@link JwtAuth} turned into a signed token on the wire (#348): the claims and header
 * templated against the request's scopes, the key found through the host (a secret, a keystore
 * entry), the token signed or reused through a {@link JwtSource}, and placed as the configuration
 * says. Every host goes through here — a run's `authFor`, and the app's previews — so a token is
 * made the same way everywhere.
 */

import { WirebenchError } from '../../errors.js';
import { signingKeyOf } from '../../keystore/index.js';
import type { Keystore } from '../../keystore/index.js';
import type { JwtAuth } from '../../project/model.js';
import type { PropertyScopes, UnresolvedRef } from '../../project/properties.js';
import type { GetSecret } from '../../secrets/resolve.js';
import { isHmacAlgorithm } from './jwt-algorithms.js';
import { templateJwtJson } from './jwt.js';
import type { JwtSource, JwtTokenRequest } from './jwt.js';
import type { SendAuth } from './send-auth.js';

/** The header a JWT goes in when the configuration names none. */
export const JWT_DEFAULT_HEADER = 'Authorization';
/** The query parameter a JWT goes in when the configuration names none. */
export const JWT_DEFAULT_QUERY = 'access_token';
/** The text before the token in a header when the configuration says nothing. */
export const JWT_DEFAULT_PREFIX = 'Bearer';

export type JwtSendAuth = Extract<SendAuth, { readonly type: 'jwt' }>;

/** Where `token` goes for `config`, with the defaults filled in. An empty prefix stays empty. */
export function jwtSendAuth(config: JwtAuth, token: string): JwtSendAuth {
  const name = config.name !== undefined && config.name !== '' ? config.name : undefined;
  return config.in === 'query'
    ? { type: 'jwt', token, in: 'query', name: name ?? JWT_DEFAULT_QUERY, prefix: '' }
    : {
        type: 'jwt',
        token,
        in: 'header',
        name: name ?? JWT_DEFAULT_HEADER,
        prefix: config.prefix ?? JWT_DEFAULT_PREFIX,
      };
}

/** What signing needs from its host. */
export interface JwtAuthDeps {
  /** The request's property scopes: the claims' and the header's strings expand against them. */
  readonly scopes: PropertyScopes;
  readonly getSecret: GetSecret;
  /** A keystore by its project entry id, with the entry's default alias; undefined when there is none. */
  keystore(id: string): Promise<{ readonly keystore: Keystore; readonly defaultAlias?: string } | undefined>;
}

/**
 * The token request for `config`: claims and header templated, the key loaded only when the source
 * actually signs.
 *
 * @throws WirebenchError `unresolved-properties` | `jwt-claims-invalid` | `jwt-header-invalid` |
 * `jwt-key-missing` (no secret or keystore configured)
 */
export function jwtTokenRequest(config: JwtAuth, deps: JwtAuthDeps): JwtTokenRequest {
  const claims = templateJwtJson(config.claims, deps.scopes, 'claims');
  const header = templateJwtJson(config.header ?? '', deps.scopes, 'header');
  refuseUnresolved([...claims.unresolved, ...header.unresolved]);
  const base = {
    algorithm: config.algorithm,
    header: header.value,
    claims: claims.value,
    issuedAt: config.issuedAt,
    jwtId: config.jwtId,
    ...(config.expiresInSeconds !== undefined ? { expiresInSeconds: config.expiresInSeconds } : {}),
  };
  if (isHmacAlgorithm(config.algorithm)) {
    const ref = present(config.secretRef);
    if (ref === undefined) throw keyMissing(`${config.algorithm} needs a secret; none is configured.`);
    return {
      ...base,
      keyIdentity: `secret:${ref}`,
      key: async () => {
        const secret = await deps.getSecret(ref);
        if (secret === undefined) {
          throw new WirebenchError('secret-missing', `Secret ${ref} was not found in the secret store.`, {
            details: { ref },
          });
        }
        return new TextEncoder().encode(secret);
      },
    };
  }
  const keystoreId = present(config.keystoreRef);
  if (keystoreId === undefined) throw keyMissing(`${config.algorithm} needs a private key; no keystore is chosen.`);
  return {
    ...base,
    keyIdentity: `keystore:${keystoreId}#${config.alias ?? ''}`,
    key: async () => {
      const found = await deps.keystore(keystoreId);
      if (found === undefined) {
        throw keyMissing('The keystore the JWT is signed with is not in this project.', { keystoreRef: keystoreId });
      }
      return signingKeyOf(found.keystore, present(config.alias) ?? found.defaultAlias);
    },
  };
}

/**
 * Signs (or reuses) the token for `config` and places it.
 *
 * @throws WirebenchError as {@link jwtTokenRequest}, plus `secret-missing` | `jwt-key-missing` |
 * `jwt-key-mismatch` and the keystore's own errors when the key is loaded
 */
export async function signConfiguredJwt(config: JwtAuth, deps: JwtAuthDeps, source: JwtSource): Promise<JwtSendAuth> {
  return jwtSendAuth(config, await source.tokenFor(jwtTokenRequest(config, deps)));
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function keyMissing(message: string, details?: Readonly<Record<string, unknown>>): WirebenchError {
  return new WirebenchError('jwt-key-missing', message, details !== undefined ? { details } : undefined);
}

function refuseUnresolved(unresolved: readonly UnresolvedRef[]): void {
  if (unresolved.length === 0) return;
  const exprs = unresolved.map((ref) => ref.expr);
  throw new WirebenchError(
    'unresolved-properties',
    `The JWT has property references nothing resolves: ${exprs.join(', ')}`,
    {
      details: { unresolved: exprs },
    },
  );
}
