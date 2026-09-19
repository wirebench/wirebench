/**
 * What secrets a config needs, and what environment variable a run reads each one from.
 *
 * A `secretRef` is opaque by design (see `resolve.ts`): it identifies an entry in the OS-keychain-
 * backed secret store, not a name a human would choose for a CI variable. A file may now declare a
 * friendlier `…Env` name beside the ref — not a secret, safe to commit — and this module is where
 * that name and the ref both turn into the environment variables a headless run is allowed to read.
 */

import type { AuthConfig, EndpointAuth } from '../project/model.js';

/** The prefix every secret-carrying environment variable name starts with. */
export const SECRET_ENV_PREFIX = 'WIREBENCH_SECRET_';

/** One secret a run must be given, and the friendlier name the file declares for it, if any. */
export interface SecretNeed {
  /** The opaque reference in the file. */
  readonly ref: string;
  /** The declared name, when the file carries one. */
  readonly envName?: string;
  /** What the secret is for, for `secrets list`: e.g. `basic password for "svc-billing"`. */
  readonly purpose: string;
}

function need(ref: string | undefined, envName: string | undefined, purpose: string): SecretNeed[] {
  return ref === undefined || ref.length === 0 ? [] : [{ ref, ...(envName !== undefined ? { envName } : {}), purpose }];
}

/** Every secret `auth` would resolve at send time. */
export function secretNeedsOfAuth(auth: AuthConfig | EndpointAuth | undefined): SecretNeed[] {
  if (auth === undefined) {
    return [];
  }
  switch (auth.type) {
    case 'basic':
    case 'ntlm':
      return need(auth.passwordRef, auth.passwordEnv, `${auth.type} password for "${auth.username ?? ''}"`);
    case 'bearer':
      return need(auth.tokenRef, auth.tokenEnv, 'bearer token');
    case 'api-key':
      return need(auth.valueRef, auth.valueEnv, `API key "${auth.name}"`);
    case 'oauth2':
      return need(auth.clientSecretRef, auth.clientSecretEnv, `OAuth2 client secret for "${auth.clientId}"`);
    default:
      return [];
  }
}

/**
 * The variables a host reads for one secret, in order: the declared name, then the reference
 * itself. The reference form exists so a project nobody has annotated can still run in CI.
 */
export function envVariablesFor(secret: Pick<SecretNeed, 'ref' | 'envName'>): string[] {
  const byRef = `${SECRET_ENV_PREFIX}${secret.ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return secret.envName !== undefined ? [`${SECRET_ENV_PREFIX}${secret.envName}`, byRef] : [byRef];
}
