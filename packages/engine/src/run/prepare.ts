/**
 * Turns one saved request into a send input, for a host with no editor: no draft to apply, no
 * user preferences to fold in, no renderer to keep credentials from. It composes the same engine
 * functions the app's main process does, in the same order, so a request runs in a pipeline the
 * way it runs when its author presses Send.
 *
 * What the app reads from the user's preferences — a global client keystore, a CA bundle, a
 * proxy, global properties — has no counterpart here: a run is described by the project, the
 * workspace it sits inside (if any) and its command line. Trust anchors beyond Node's own come from
 * `NODE_EXTRA_CA_CERTS`.
 */
import { expandGrpcInput } from '../grpc/expand.js';
import type { GrpcSendInput } from '../grpc/send.js';
import { prepareRest } from '../rest/run.js';
import type { PreparedRest } from '../rest/run.js';
import { toGrpcSendInput } from '../send-options.js';
import { grpcEffectiveAuth } from './effective-auth.js';
import { prepareSoap } from '../soap/run.js';
import type { PreparedSoap } from '../soap/run.js';
import type { SelectedRequest } from './select.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import { authFor, baseUrlFor, tlsFor, unresolvedError, withSecrets } from './send-helpers.js';

export { authFor } from './send-helpers.js';
export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';

/**
 * One request, ready for `sendSoapRequest` (with `scopes`), `sendRest`, or `callGrpc` (with the
 * API's proto set, which the caller loads: preparing a call needs no schema). It carries resolved
 * secret values (auth, `scopes.secrets`) but no list of them: the host masks what its `GetSecret`
 * handed out (see `GetSecret`).
 */
export type PreparedSend =
  | PreparedSoap
  | PreparedRest
  | {
      readonly kind: 'grpc';
      // The streaming hooks are left out: a run makes unary calls, and wants only the result.
      readonly input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;
      readonly messageText: string;
    };

type GrpcSelected = Extract<SelectedRequest, { kind: 'grpc' }>;

/**
 * The app's `resolveGrpcSend` plus what its send handler adds: the target through the
 * environment's override for the API (the slot a REST base URL uses), the settings ladder, one
 * expansion pass over target, metadata and message, then the request's own TLS identity and trust
 * decision and the chain's credentials. There is no proxy: the app sends gRPC direct as well.
 */
async function prepareGrpc(selected: GrpcSelected, context: RunContext): Promise<PreparedSend> {
  const { api, request } = selected;
  const scopes = scopesFor(context);
  const tls = await tlsFor(context, request.settings.sslKeystoreRef, request.settings.trustInvalid === true);
  const auth = await authFor(grpcEffectiveAuth(selected), selected.path, context, tls);
  const target = baseUrlFor(context, { slug: api.slug, baseUrl: api.target });
  const unexpanded = toGrpcSendInput({
    request: {
      service: request.service,
      method: request.method,
      methodKind: request.methodKind,
      metadata: request.metadata,
      settings: request.settings,
    },
    target,
    tls: api.tls,
    apiMetadata: api.metadata,
    projectSettings: context.project.settings,
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tlsOptions: tls } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  const withMessage = { ...unexpanded, messageText: request.message };
  const withTokens = await withSecrets(withMessage, scopes, context.getSecret, context.secretPlaceholders);
  const { input, unresolved } = expandGrpcInput(withMessage, withTokens, {
    escape: request.settings.escapeProperties === true,
  });
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  const { messageText, ...transport } = input;
  return {
    kind: 'grpc',
    input: { ...transport, ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}) },
    messageText,
  };
}

/**
 * @throws WirebenchError `unresolved-properties` | `endpoint-unresolved` | `secret-missing` |
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing` | `webhook-signing-secret`
 */
export function prepareSend(selected: SelectedRequest, context: RunContext): Promise<PreparedSend> {
  switch (selected.kind) {
    case 'soap':
      return prepareSoap(selected, context);
    case 'rest':
      return prepareRest(selected, context);
    case 'grpc':
      return prepareGrpc(selected, context);
  }
}
