/**
 * Turning a saved gRPC request into a call: the one place the layers meet.
 *
 * The renderer sends a request id and, when the editor has unsaved edits, the draft patch. Where the
 * call actually goes — the API's target under the active environment (the same override slot a REST
 * base URL uses), property expansion across every scope, the credentials the folder chain resolves
 * to, the settings the request inherits — is decided here, in main, because the renderer has neither
 * the environment, the model, nor the keychain.
 *
 * Secrets are deliberately *not* resolved here, and the `.proto` set is not loaded: this function is
 * synchronous and material-free, so the same result feeds the command export and the preflight badge.
 */

import { expandGrpcInput, resolveAuthChain, toGrpcSendInput } from '@wirebench/engine';
import type {
  AuthConfig,
  BaseUrlSource,
  GrpcApi,
  GrpcRequestDef,
  GrpcSendInput,
  Preferences,
  Project,
  PropertyScopes,
  UnresolvedRef,
} from '@wirebench/engine';
import type { GrpcRequestPatchWire } from '../shared/wire-types.js';
import { grpcAuthChainFor, locateGrpcRequest, withGrpcPatch } from './project-grpc-mutations.js';
import { withSecretTokenScope } from './secret-resolver.js';

/** What one resolved gRPC call knows about itself, beyond the transport input the engine consumes. */
export interface GrpcSendResolution {
  /** Everything the transport needs but the encoded messages, every property expanded. */
  readonly input: Omit<GrpcSendInput, 'messages'>;
  /** The request message text, expanded, ready for the codec. */
  readonly messageText: string;
  /** Property references nothing resolved. A send is refused when this is non-empty. */
  readonly unresolved: readonly UnresolvedRef[];
  readonly api: GrpcApi;
  /** The request as it will be sent: the saved one with the editor's draft applied. */
  readonly request: GrpcRequestDef;
  /** Where the target came from, for the preflight badge. */
  readonly targetSource: BaseUrlSource;
  /** The credentials that apply, still as `secretRef`s. */
  readonly auth: AuthConfig;
}

/** Everything {@link resolveGrpcSend} needs. */
export interface ResolveGrpcSendArgs {
  readonly project: Project;
  readonly requestId: string;
  readonly draft?: GrpcRequestPatchWire;
  readonly scopes: PropertyScopes;
  readonly preferences?: Preferences;
  /** Resolves the API's target the way the project is open (workspace environment, or its own). */
  readonly resolveTarget: (api: GrpcApi) => { readonly url: string; readonly source: BaseUrlSource };
}

/**
 * Resolves one gRPC call: draft first, then the target, then the settings ladder, then one
 * expansion pass over target, metadata and message together — `${secret:name}` tokens included
 * when `resolveWithStoredValues` runs it.
 *
 * Returns `undefined` when no such gRPC request exists.
 */
export function resolveGrpcSend(args: ResolveGrpcSendArgs): GrpcSendResolution | undefined {
  const located = locateGrpcRequest(args.project, args.requestId);
  if (located === undefined) {
    return undefined;
  }
  const { api } = located;
  const request = withGrpcPatch(located.request, args.draft);
  const target = args.resolveTarget(api);

  const savedChain = grpcAuthChainFor(args.project, args.requestId) ?? [request.auth];
  const auth = resolveAuthChain([request.auth, ...savedChain.slice(1)]);

  const unexpanded = toGrpcSendInput({
    request: {
      service: request.service,
      method: request.method,
      methodKind: request.methodKind,
      metadata: request.metadata,
      settings: request.settings,
    },
    target: target.url,
    tls: api.tls,
    apiMetadata: api.metadata,
    ...(args.preferences !== undefined ? { preferences: args.preferences } : {}),
    projectSettings: args.project.settings,
  });

  const scopes = withSecretTokenScope(args.scopes);
  const { input, unresolved } = expandGrpcInput({ ...unexpanded, messageText: request.message }, scopes, {
    escape: request.settings.escapeProperties === true,
  });
  const { messageText, ...transport } = input;

  return { input: transport, messageText, unresolved, api, request, targetSource: target.source, auth };
}
