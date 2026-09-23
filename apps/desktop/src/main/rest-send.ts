/**
 * Turning a saved REST request into a send input: the one place the layers meet.
 *
 * The renderer sends a request id and, when the editor has unsaved edits, the draft patch it is
 * looking at. Everything that decides where the request actually goes — the API's base URL under
 * the active environment, property expansion across every scope, the credentials its folder chain
 * resolves to, the transport settings it inherits — is decided here, in main, because the renderer
 * has neither the environment, the project model, nor the keychain.
 *
 * Secrets are deliberately *not* resolved here: this function is synchronous and material-free, so
 * the same result can feed the cURL export and the preflight badge without a keychain round trip.
 * `ipc/request.ts` resolves the references afterwards, exactly as the SOAP path does.
 */

import { resolveAuthChain, toRestSendInput } from '@wirebench/engine';
import { expandRestSendInput } from '@wirebench/engine';
import type {
  AuthConfig,
  BaseUrlSource,
  Cookie,
  Preferences,
  Project,
  ProxyOptions,
  PropertyScopes,
  RestApi,
  RestRequestDef,
  RestRequestSettings,
  RestSendInput,
  TlsOptions,
  UnresolvedRef,
} from '@wirebench/engine';
import {
  authChainFor,
  findRestRequest,
  toEngineAuthConfig,
  toEngineBody,
  toEngineRows,
} from './project-rest-mutations.js';
import { withSecretTokenScope } from './secret-resolver.js';
import type { RestRequestPatchWire } from '../shared/wire-types.js';

/** What one resolved REST send knows about itself, beyond the input the engine will consume. */
export interface RestSendResolution {
  readonly input: RestSendInput;
  /** Property references nothing resolved. A send is refused when this is non-empty. */
  readonly unresolved: readonly UnresolvedRef[];
  readonly api: RestApi;
  /** The request as it will be sent: the saved one with the editor's draft applied. */
  readonly request: RestRequestDef;
  /** Where the base URL came from, for the Details inspector and the preflight badge. */
  readonly baseUrlSource: BaseUrlSource;
  /** The credentials that apply, still as `secretRef`s. */
  readonly auth: AuthConfig;
}

/** Everything {@link resolveRestSend} needs. */
export interface ResolveRestSendArgs {
  readonly project: Project;
  readonly requestId: string;
  /** The editor's unsaved edits, applied on top of the saved request for this send only. */
  readonly draft?: RestRequestPatchWire;
  readonly scopes: PropertyScopes;
  readonly preferences?: Preferences;
  /** Resolves the API's base URL the way the project is open (workspace environment, or its own). */
  readonly resolveBaseUrl: (api: RestApi) => { readonly url: string; readonly source: BaseUrlSource };
  /** Cookies this request's own last response set, when its *send cookies* setting is on. */
  readonly cookies?: readonly Cookie[];
  /** TLS material the host resolved: trust anchors, a client identity, a per-request trust decision. */
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
}

/** The API that holds `requestId`, and the request itself. */
function locate(project: Project, requestId: string): { api: RestApi; request: RestRequestDef } | undefined {
  const request = findRestRequest(project, requestId);
  if (request === undefined) {
    return undefined;
  }
  const api = project.apis.find(
    (candidate) => findRestRequest({ ...project, apis: [candidate] }, requestId) !== undefined,
  );
  return api === undefined ? undefined : { api, request };
}

/** The saved request with the editor's draft applied, for this send only — nothing is persisted. */
function withDraft(request: RestRequestDef, draft: RestRequestPatchWire | undefined): RestRequestDef {
  if (draft === undefined) {
    return request;
  }
  return {
    ...request,
    ...(draft.method !== undefined ? { method: draft.method } : {}),
    ...(draft.url !== undefined ? { url: draft.url } : {}),
    ...(draft.pathParams !== undefined ? { pathParams: toEngineRows(draft.pathParams) } : {}),
    ...(draft.query !== undefined ? { query: toEngineRows(draft.query) } : {}),
    ...(draft.headers !== undefined ? { headers: toEngineRows(draft.headers) } : {}),
    ...(draft.body !== undefined ? { body: toEngineBody(draft.body) } : {}),
    ...(draft.auth !== undefined ? { auth: toEngineAuthConfig(draft.auth) } : {}),
    ...(draft.settings !== undefined ? { settings: cleanSettings(draft.settings) } : {}),
  };
}

/** Settings from the wire, with the keys the sender left undefined dropped (they mean *inherit*). */
function cleanSettings(settings: NonNullable<RestRequestPatchWire['settings']>): RestRequestSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}

/**
 * Resolves one REST send.
 *
 * Order matters: the draft is applied first (it is what the user is looking at), then the base URL
 * is resolved, then the settings ladder is climbed, then properties are expanded across the whole
 * input at once — so a base URL that is itself a property, and a path parameter that is another,
 * both resolve against the same scopes in one pass. `${secret:name}` tokens expand only inside
 * `resolveWithStoredValues`, which puts their values in scope; anywhere else they stay unresolved.
 *
 * Returns `undefined` when no such REST request exists, which is what a send of a request that has
 * since been deleted means.
 */
export function resolveRestSend(args: ResolveRestSendArgs): RestSendResolution | undefined {
  const located = locate(args.project, args.requestId);
  if (located === undefined) {
    return undefined;
  }
  const { api } = located;
  const request = withDraft(located.request, args.draft);
  const base = args.resolveBaseUrl(api);

  // The draft may change which credentials apply (the Auth tab is editable), so the chain is taken
  // from the saved tree and its innermost link replaced with the request as it stands.
  const savedChain = authChainFor(args.project, args.requestId) ?? [request.auth];
  const chain = [request.auth, ...savedChain.slice(1)];
  const auth = resolveAuthChain(chain);

  const unexpanded = toRestSendInput({
    request: {
      method: request.method,
      url: request.url,
      pathParams: request.pathParams,
      query: request.query,
      headers: request.headers,
      body: request.body,
      settings: request.settings,
    },
    baseUrl: base.url,
    ...(args.preferences !== undefined ? { preferences: args.preferences } : {}),
    projectSettings: args.project.settings,
    ...(args.cookies !== undefined ? { cookies: args.cookies } : {}),
    ...(args.tls !== undefined ? { tls: args.tls } : {}),
    ...(args.proxy !== undefined ? { proxy: args.proxy } : {}),
  });

  const { input, unresolved } = expandRestSendInput(unexpanded, withSecretTokenScope(args.scopes), {
    escape: request.settings.escapeProperties === true,
  });

  return { input, unresolved, api, request, baseUrlSource: base.source, auth };
}
