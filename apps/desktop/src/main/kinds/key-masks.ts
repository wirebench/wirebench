/** What a send masks of an API key or a JWT, shared by the kinds' send steps (spec §5.5). */
import { jwtSendAuth } from '@wirebench/engine';
import type { AuthConfig } from '@wirebench/engine';
import type { KeyMasks } from './kind-main.js';

/**
 * Where a credential that travels under a name of the user's choosing goes: an API key's header or
 * query parameter, or a JWT's (#348), with the JWT's defaults filled in. Undefined for any other
 * scheme, whose header the masker already knows by name.
 */
export function namedCredential(
  auth: AuthConfig,
): { readonly in: 'header' | 'query'; readonly name: string } | undefined {
  if (auth.type === 'api-key') return { in: auth.in, name: auth.name };
  if (auth.type === 'jwt') {
    const placed = jwtSendAuth(auth, '');
    return { in: placed.in, name: placed.name };
  }
  return undefined;
}

/**
 * The masks of an API key or JWT in the query or a header: the one query parameter it may be
 * configured to travel in, so the URL is masked wherever it is logged even when it is called
 * something this build has never heard of; and the header one, masked by name wherever the headers
 * are shown.
 */
export function apiKeyMasks(auth: AuthConfig): KeyMasks {
  const named = namedCredential(auth);
  if (named === undefined) return {};
  return named.in === 'query' ? { keyParams: [named.name] } : { keyHeaders: [named.name] };
}
