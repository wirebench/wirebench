/**
 * The authentication a selected request would send with, before any secret is resolved. Both
 * `prepareSend` and `secretNeedsOf` read it from here, so the secrets a run is told it needs are
 * exactly the secrets its sends will ask for.
 */
import type { AuthConfig } from '../project/model.js';
import { resolveAuthChain } from '../rest/auth.js';
import type { SelectedRequest } from './select.js';
/** The same chain for a gRPC request: request, its folders inside-out, the API. */
export function grpcEffectiveAuth(selected: Extract<SelectedRequest, { kind: 'grpc' }>): AuthConfig {
  const { api, chain, request } = selected;
  return resolveAuthChain([request.auth, ...[...chain].reverse().map((folder) => folder.auth), api.auth]);
}
