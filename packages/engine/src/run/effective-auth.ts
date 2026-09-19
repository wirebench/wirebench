/**
 * The authentication a selected request would send with, before any secret is resolved. Both
 * `prepareSend` and `secretNeedsOf` read it from here, so the secrets a run is told it needs are
 * exactly the secrets its sends will ask for.
 */
import { effectiveAuth } from '../project/endpoints.js';
import { resolveAuthEndpoint } from '../project/environments.js';
import type { AuthConfig, EndpointAuth } from '../project/model.js';
import { resolveAuthChain } from '../rest/auth.js';
import type { SelectedRequest } from './select.js';

/** A SOAP request's own auth, combined with its endpoint's, falling back to the interface's. */
export function soapEffectiveAuth(selected: Extract<SelectedRequest, { kind: 'soap' }>): EndpointAuth | undefined {
  const { iface, request } = selected;
  const endpoint = resolveAuthEndpoint(iface, request);
  return effectiveAuth(request.auth, endpoint?.auth, endpoint?.authMode ?? 'override', iface.auth);
}

/** Innermost first, as the app's `authChainFor` builds it: request, its folders inside-out, the API. */
export function restEffectiveAuth(selected: Extract<SelectedRequest, { kind: 'rest' }>): AuthConfig {
  const { api, chain, request } = selected;
  return resolveAuthChain([request.auth, ...[...chain].reverse().map((folder) => folder.auth), api.auth]);
}
