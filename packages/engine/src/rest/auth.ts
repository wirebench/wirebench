/**
 * Working out which credentials a REST request uses, and turning them into what goes on the wire.
 *
 * Two halves, both pure. {@link resolveAuthChain} walks the inheritance chain — request, then each
 * folder outwards, then the API — and answers with the first configuration that is not `inherit`.
 * {@link applyAuth} takes credentials the host has already resolved (values, not `secretRef`s) and
 * says what to add to the headers or the query string.
 *
 * Basic and NTLM are deliberately *not* applied here: they may need a challenge round trip, which
 * is the transport's job (`http/auth/*`), and this module never touches the network.
 */

import type { AuthConfig } from '../project/model.js';
import type { SendAuth } from '../types.js';
import type { KeyValueEntry } from './model.js';

/** Nothing configured anywhere in a chain means no credentials at all. */
const NO_AUTH: AuthConfig = { type: 'none' };

/**
 * The credentials that actually apply, given a request's own configuration followed by its
 * folders from the inside out and finally its API's.
 *
 * `inherit` means "ask the next one up", and an `undefined` link — a folder or API that configures
 * nothing — is the same thing. Running out of chain means `none`: an API with no credentials
 * authenticates its requests with none, rather than with whatever a sibling API happens to use.
 */
export function resolveAuthChain(chain: readonly (AuthConfig | undefined)[]): AuthConfig {
  for (const link of chain) {
    if (link !== undefined && link.type !== 'inherit') {
      return link;
    }
  }
  return NO_AUTH;
}

/** Which link of a chain supplied the effective credentials, for the editor to explain. */
export function resolveAuthChainIndex(chain: readonly (AuthConfig | undefined)[]): number {
  return chain.findIndex((link) => link !== undefined && link.type !== 'inherit');
}

/** What {@link applyAuth} adds to a request. */
export interface AppliedAuth {
  /** Headers to merge in. A header the request set itself wins over these (see `rest/send.ts`). */
  readonly headers: Readonly<Record<string, string>>;
  /** Query rows to append, for an API key that travels in the query string. */
  readonly query: readonly KeyValueEntry[];
  /**
   * Credentials the transport has to handle itself, because they may need a challenge round trip:
   * Basic and NTLM. Passed through to `sendHttp` untouched.
   */
  readonly transportAuth?: SendAuth;
}

/**
 * Turns resolved credentials into headers, query rows, or a transport handoff.
 *
 * A Basic credential marked preemptive is still handed to the transport rather than encoded here,
 * so there is exactly one implementation of the header and one of the challenge flow.
 */
export function applyAuth(auth: SendAuth | undefined): AppliedAuth {
  if (auth === undefined) {
    return { headers: {}, query: [] };
  }
  switch (auth.type) {
    case 'bearer':
      return { headers: { Authorization: `${auth.scheme ?? 'Bearer'} ${auth.token}` }, query: [] };
    case 'oauth2':
      return { headers: { Authorization: `Bearer ${auth.accessToken}` }, query: [] };
    case 'api-key':
      return auth.in === 'header'
        ? { headers: { [auth.name]: auth.value }, query: [] }
        : { headers: {}, query: [{ name: auth.name, value: auth.value, enabled: true }] };
    default:
      return { headers: {}, query: [], transportAuth: auth };
  }
}

/**
 * Whether a configuration still needs a secret the host has not resolved — a token, key or client
 * secret whose reference is missing or empty.
 *
 * Used to tell "not configured yet" (a request being written) from "configured and broken" (a
 * reference whose secret is gone, e.g. a project opened on another machine), which are different
 * problems with different fixes.
 */
export function missingSecretRef(auth: AuthConfig): 'tokenRef' | 'valueRef' | 'clientSecretRef' | undefined {
  switch (auth.type) {
    case 'bearer':
      return auth.tokenRef === undefined || auth.tokenRef === '' ? 'tokenRef' : undefined;
    case 'api-key':
      return auth.valueRef === undefined || auth.valueRef === '' ? 'valueRef' : undefined;
    case 'oauth2':
      // A public client legitimately has no secret, so only a confidential one is incomplete
      // without it: `clientAuth: 'basic'` is the confidential form.
      return auth.clientAuth === 'basic' && (auth.clientSecretRef === undefined || auth.clientSecretRef === '')
        ? 'clientSecretRef'
        : undefined;
    default:
      return undefined;
  }
}
