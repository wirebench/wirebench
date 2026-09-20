/**
 * Turning a saved WebSocket request into a call: the twin of `grpc-send.ts`.
 *
 * The renderer sends a request id and, when the editor has unsaved edits, the draft patch. Where
 * the session actually dials — the API's target under the active environment (the same override
 * slot a REST/gRPC target uses), property expansion across every scope, the credentials the folder
 * chain resolves to, the settings the request inherits — is decided here, in main, because the
 * renderer has neither the environment, the model, nor the keychain.
 *
 * Secrets are deliberately *not* resolved here: this function is synchronous and material-free, so
 * the same result feeds the command export and the preflight badge. Message text is not expanded
 * or sent here either — a session is opened first, and each message is expanded and pushed
 * separately (`request.wsSend`), since a session may outlive the one message that opened it.
 */

import { DEFAULT_PREFERENCES, expand, expandWsInput, resolveAuthChain } from '@wirebench/engine';
import type {
  AuthConfig,
  BaseUrlSource,
  Preferences,
  Project,
  PropertyScopes,
  UnresolvedRef,
  WsApi,
  WsCallInput,
  WsRequestDef,
  WsRequestSettings,
} from '@wirebench/engine';
import type { WsRequestPatchWire } from '../shared/wire-types.js';
import { locateWsRequest, wsAuthChainFor, withWsPatch } from './project-ws-mutations.js';

/** What one resolved WebSocket call knows about itself, beyond the transport input the engine consumes. */
export interface WsSendResolution {
  /** Everything `toWsSessionOptions` needs, every property expanded. */
  readonly input: WsCallInput;
  /** Property references nothing resolved. A send is refused when this is non-empty. */
  readonly unresolved: readonly UnresolvedRef[];
  readonly api: WsApi;
  /** The request as it will be sent: the saved one with the editor's draft applied. */
  readonly request: WsRequestDef;
  /** Where the target came from, for the preflight badge. */
  readonly urlSource: BaseUrlSource;
  /** The credentials that apply, still as `secretRef`s. */
  readonly auth: AuthConfig;
}

/** Everything {@link resolveWsSend} needs. */
export interface ResolveWsSendArgs {
  readonly project: Project;
  readonly requestId: string;
  readonly draft?: WsRequestPatchWire;
  readonly scopes: PropertyScopes;
  readonly preferences?: Preferences;
  /** Resolves the API's target the way the project is open (workspace environment, or its own). */
  readonly resolveTarget: (api: WsApi) => { readonly url: string; readonly source: BaseUrlSource };
}

/**
 * The effective `WsRequestSettings` a request sends with, request settings resolved against
 * project/preference defaults.
 *
 * A `WsApi` carries no settings of its own to inherit from (unlike a gRPC or REST API), so this
 * ladder is shorter than `toGrpcSendInput`'s: only `handshakeTimeoutMs` has a project/preference
 * fallback (mirroring gRPC's `timeoutMs`, sourced from `project.settings.defaultTimeoutMs` and then
 * `preferences.http.socketTimeoutMs`); `trustInvalid`, `sslKeystoreRef`, `bindAddress` and
 * `maxMessageBytes` are the request's own or absent — there is no engine helper this reproduces
 * from, so the logic lives here rather than in a modified `toGrpcSendInput`.
 */
function effectiveWsSettings(
  request: WsRequestSettings,
  project: Project,
  preferences: Preferences,
): WsRequestSettings {
  const handshakeTimeoutMs =
    request.handshakeTimeoutMs ?? project.settings.defaultTimeoutMs ?? preferences.http.socketTimeoutMs;
  return {
    ...request,
    handshakeTimeoutMs,
  };
}

/**
 * Resolves one WebSocket call: draft first, then the target, then the settings ladder, then one
 * expansion pass over the URL, query, headers and subprotocols.
 *
 * Returns `undefined` when no such WebSocket request exists.
 */
export function resolveWsSend(args: ResolveWsSendArgs): WsSendResolution | undefined {
  const located = locateWsRequest(args.project, args.requestId);
  if (located === undefined) {
    return undefined;
  }
  const { api } = located;
  const request = withWsPatch(located.request, args.draft);
  const target = args.resolveTarget(api);

  const savedChain = wsAuthChainFor(args.project, args.requestId) ?? [request.auth];
  const auth = resolveAuthChain([request.auth, ...savedChain.slice(1)]);

  const preferences = args.preferences ?? DEFAULT_PREFERENCES;
  const settings = effectiveWsSettings(request.settings, args.project, preferences);

  const unexpanded: WsCallInput = {
    serverUrl: target.url,
    request: {
      url: request.url,
      query: request.query,
      headers: request.headers,
      subprotocols: request.subprotocols,
      settings,
    },
    apiHeaders: api.headers,
  };

  // `expandWsInput` deliberately does not touch `serverUrl` (it expands the request's own fields
  // and the API headers only — see `ws/expand.ts`); the target is expanded here, the same one
  // extra `expand()` call `expandGrpcInput` folds into its own pass for gRPC's `target` field.
  const expandedServer = expand(target.url, args.scopes);
  const { input: expandedRest, unresolved: restUnresolved } = expandWsInput(unexpanded, args.scopes);
  const input: WsCallInput = { ...expandedRest, serverUrl: expandedServer.text };
  const unresolved = [...expandedServer.unresolved, ...restUnresolved];

  return { input, unresolved, api, request, urlSource: target.source, auth };
}
