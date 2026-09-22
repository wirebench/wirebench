/**
 * Endpoint-level credential precedence: how a request's own auth combines with the auth
 * configured on the endpoint it is sent to (and, as a last resort, on its interface). Pure — the
 * desktop app resolves the resulting `passwordRef`/`tokenRef`/etc. afterwards.
 */

import type { EndpointAuth, SoapOwnerAuth } from './model.js';

/** Narrows a {@link SoapOwnerAuth} to the {@link EndpointAuth} arm (Basic/NTLM/none). */
function isEndpointAuth(auth: SoapOwnerAuth): auth is EndpointAuth {
  return auth.type === 'none' || auth.type === 'basic' || auth.type === 'ntlm';
}

/**
 * Combines request, endpoint and interface credentials for one send.
 *
 * `override` (the endpoint wins): a defined endpoint auth replaces the request's entirely —
 * including an explicit `{ type: 'none' }`, which deliberately turns authentication off.
 * `complement` (the endpoint only fills blanks): when both sides are Basic/NTLM/none — the only
 * arms with fields to share — start from the request's auth and take `username`, `passwordRef`,
 * `domain` and `preemptive` from the endpoint wherever the request left them undefined, plus
 * `type` when the request has no type or asks for `none`. For any other combination (a token
 * scheme on either side) `complement` means the request's own auth, unless it is absent or
 * `none`, then the endpoint's — field-merging a Bearer/API-key/OAuth2 config has no shared shape
 * to merge into.
 *
 * When nothing is configured at either level, the interface's auth applies unchanged.
 *
 * @param requestAuth the request's own credentials, if any
 * @param endpointAuth the credentials configured on the target endpoint, if any
 * @param authMode how the endpoint's credentials combine with the request's
 * @param interfaceAuth the interface-wide fallback, if any
 */
export function effectiveAuth(
  requestAuth: SoapOwnerAuth | undefined,
  endpointAuth: SoapOwnerAuth | undefined,
  authMode: 'override' | 'complement',
  interfaceAuth?: SoapOwnerAuth,
): SoapOwnerAuth | undefined {
  return combine(requestAuth, endpointAuth, authMode) ?? interfaceAuth;
}

function combine(
  requestAuth: SoapOwnerAuth | undefined,
  endpointAuth: SoapOwnerAuth | undefined,
  authMode: 'override' | 'complement',
): SoapOwnerAuth | undefined {
  if (authMode === 'override') {
    return endpointAuth ?? requestAuth;
  }
  if (endpointAuth === undefined) {
    return requestAuth;
  }
  if (requestAuth === undefined) {
    return endpointAuth;
  }
  if (!isEndpointAuth(requestAuth) || !isEndpointAuth(endpointAuth)) {
    return requestAuth.type === 'none' ? endpointAuth : requestAuth;
  }
  const type = requestAuth.type === 'none' ? endpointAuth.type : requestAuth.type;
  const username = requestAuth.username ?? endpointAuth.username;
  const passwordRef = requestAuth.passwordRef ?? endpointAuth.passwordRef;
  const domain = requestAuth.domain ?? endpointAuth.domain;
  const preemptive = requestAuth.preemptive ?? endpointAuth.preemptive;
  return {
    type,
    ...(username !== undefined ? { username } : {}),
    ...(passwordRef !== undefined ? { passwordRef } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(preemptive !== undefined ? { preemptive } : {}),
  };
}
