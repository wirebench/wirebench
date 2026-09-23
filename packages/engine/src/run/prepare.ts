/**
 * Turns one saved request into a send input, for a host with no editor: no draft to apply, no
 * user preferences to fold in, no renderer to keep credentials from. It composes the same engine
 * functions the app's main process does, in the same order, so a request runs in a pipeline the
 * way it runs when its author presses Send.
 *
 * What the app reads from the user's preferences — a global client keystore, a CA bundle, a
 * proxy, global properties — has no counterpart here: a run is described by the project and its
 * command line alone. Trust anchors beyond Node's own come from `NODE_EXTRA_CA_CERTS`.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { WirebenchError } from '../errors.js';
import { isInsideRealDir } from '../fs.js';
import { expandGrpcInput } from '../grpc/expand.js';
import type { GrpcSendInput } from '../grpc/send.js';
import type { HttpExchange, HttpRequest, ProxyOptions, TlsOptions } from '../http/types.js';
import { createFileAttachmentResolver, readAttachment } from '../project/attachments-cache.js';
import { resolveApiBaseUrl, resolveEndpoint, resolveScopes } from '../project/environments.js';
import { toKeystoreDef } from '../project/keystores.js';
import type { Attachment, AttachmentSource, AuthConfig, Project, PropertyMap } from '../project/model.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { expandSendInput } from '../project/properties.js';
import { toWssIncomingConfig, toWssOutgoingConfig } from '../project/wss-configs.js';
import { expandRestSendInput } from '../rest/expand.js';
import type { RestSendInput } from '../rest/send.js';
import { resolveAuthConfig, resolveSecretTokens, resolveSoapAuth } from '../secrets/resolve.js';
import type { GetSecret } from '../secrets/resolve.js';
import { toGrpcSendInput, toRestSendInput, toSendInput } from '../send-options.js';
import type { AttachmentResolvers } from '../send-options.js';
import type { SoapSendInput, SoapSendWss } from '../types.js';
import { effectiveWsa } from '../wsa/model.js';
import { loadKeystore, toTlsClientIdentity } from '../wss/keystore/index.js';
import type { Keystore } from '../wss/keystore/index.js';
import { createWssContext } from '../wss/model.js';
import { grpcEffectiveAuth, restEffectiveAuth, soapEffectiveAuth } from './effective-auth.js';
import { createRunTokenSource, requiredSecret } from './oauth2-token.js';
import type { RunTokenSource } from './oauth2-token.js';
import { secretNamesInValue } from './secret-needs.js';
import type { SelectedRequest } from './select.js';

/** Everything a run supplies around the saved requests it sends. */
export interface RunContext {
  readonly project: Project;
  /** The project folder: keystores, attachments and file bodies are read from inside it only. */
  readonly projectDir: string;
  readonly environmentId?: string;
  /** `--var` overrides, laid over the environment's properties. */
  readonly overrides: PropertyMap;
  readonly getSecret: GetSecret;
  readonly timeoutMs?: number;
  readonly insecure?: boolean;
  readonly proxyFor?: (url: string) => ProxyOptions | undefined;
  readonly signal?: AbortSignal;
  /**
   * The WSDL-derived default `wsa:Action` for a SOAP request, as the app takes it from the
   * interface's imported definition. Absent (or returning `''`) when no definition is at hand:
   * an explicit `wsa:Action` or the request's SOAPAction then still applies.
   */
  readonly defaultWsaActionFor?: (selected: Extract<SelectedRequest, { kind: 'soap' }>) => string;
  /** Told every OAuth2 access token the run obtains, so the host can mask it in all it prints. */
  readonly onSecretValue?: (value: string) => void;
  /** Sends an OAuth2 token request; the engine's `sendHttp` by default. A test seam. */
  readonly fetchToken?: (request: HttpRequest) => Promise<HttpExchange>;
  /**
   * The run's OAuth2 token cache. `runRequests` creates one per run so every request behind a
   * configuration shares a token; a lone `prepareSend` without one gets a fresh source.
   */
  readonly tokenSource?: RunTokenSource;
}

/**
 * One request, ready for `sendSoapRequest` (with `scopes`), `sendRest`, or `callGrpc` (with the
 * API's proto set, which the caller loads: preparing a call needs no schema). It carries resolved
 * secret values (auth, `scopes.secrets`) but no list of them: the host masks what its `GetSecret`
 * handed out (see `GetSecret`).
 */
export type PreparedSend =
  | { readonly kind: 'soap'; readonly input: SoapSendInput; readonly scopes: PropertyScopes }
  | { readonly kind: 'rest'; readonly input: RestSendInput }
  | {
      readonly kind: 'grpc';
      // The streaming hooks are left out: a run makes unary calls, and wants only the result.
      readonly input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;
      readonly messageText: string;
    };

type SoapSelected = Extract<SelectedRequest, { kind: 'soap' }>;
type RestSelected = Extract<SelectedRequest, { kind: 'rest' }>;
type GrpcSelected = Extract<SelectedRequest, { kind: 'grpc' }>;

function scopesFor(context: RunContext): PropertyScopes {
  const scopes = resolveScopes(context.project, context.environmentId, {}, process.env);
  return { ...scopes, env: { ...(scopes.env ?? {}), ...context.overrides } };
}

/**
 * `scopes` with the value of every `${secret:name}` token `input` reaches. Each value comes from
 * `getSecret`, so a host that masks what it hands out (the CLI's `createEnvSecrets`) masks these too.
 */
async function withSecrets(input: unknown, scopes: PropertyScopes, getSecret: GetSecret): Promise<PropertyScopes> {
  const names = secretNamesInValue(input, scopes);
  return names.length === 0 ? scopes : { ...scopes, secrets: await resolveSecretTokens(names, getSecret) };
}

function unresolvedError(path: string, unresolved: readonly UnresolvedRef[]): WirebenchError {
  const exprs = unresolved.map((ref) => ref.expr);
  return new WirebenchError(
    'unresolved-properties',
    `"${path}" has property references nothing resolves: ${exprs.join(', ')}`,
    { details: { path, unresolved: exprs } },
  );
}

/**
 * `path` resolved against the project folder, refused when it lands outside it. The app also
 * accepts a file its user picked through a dialog; a pipeline has no such user, so the project
 * folder is the whole boundary.
 */
async function insideProject(context: RunContext, path: string, code: string, name: string): Promise<string> {
  const resolved = resolvePath(context.projectDir, path);
  if (!(await isInsideRealDir(context.projectDir, resolved))) {
    throw new WirebenchError(code, `"${name}" resolves outside the project folder.`, { details: { path } });
  }
  return resolved;
}

/** Mirrors the app's keystore loading, minus its cache: a run loads each keystore it needs. */
async function loadKeystoreById(context: RunContext, keystoreId: string): Promise<Keystore | undefined> {
  const ref = context.project.wss.keystores.find((candidate) => candidate.id === keystoreId);
  if (ref === undefined) {
    return undefined;
  }
  const def = toKeystoreDef(ref);
  const path = await insideProject(context, def.path, 'keystore-outside-project', def.name);
  try {
    await stat(path);
  } catch (error) {
    throw new WirebenchError('keystore-unreadable', `The keystore file "${def.path}" could not be read.`, {
      details: { id: def.id },
      cause: error,
    });
  }
  const password =
    def.passwordSecretRef === undefined ? undefined : await requiredSecret(def.passwordSecretRef, context.getSecret);
  return loadKeystore(await readFile(path), { type: def.type, ...(password !== undefined ? { password } : {}) });
}

/** The `cert`/`key` a request's own keystore presents; there is no global keystore in a run. */
async function clientIdentityFor(context: RunContext, keystoreId: string | undefined): Promise<TlsOptions | undefined> {
  if (keystoreId === undefined || keystoreId.length === 0) {
    return undefined;
  }
  const keystore = await loadKeystoreById(context, keystoreId);
  const def = context.project.wss.keystores.find((candidate) => candidate.id === keystoreId);
  if (keystore === undefined || def === undefined) {
    throw new WirebenchError('keystore-missing', 'This request selects a keystore the project no longer has.', {
      details: { keystoreId },
    });
  }
  const identity = toTlsClientIdentity(keystore, toKeystoreDef(def).defaultAlias);
  return { cert: identity.cert, key: identity.key };
}

/** Identity, then the only two trust opt-outs a run honours: `--insecure` and the file's own flag. */
async function tlsFor(
  context: RunContext,
  keystoreId: string | undefined,
  trustInvalid: boolean,
): Promise<TlsOptions | undefined> {
  const identity = await clientIdentityFor(context, keystoreId);
  const skipVerify = context.insecure === true || trustInvalid;
  if (identity === undefined && !skipVerify) {
    return undefined;
  }
  return { ...identity, ...(skipVerify ? { rejectUnauthorized: false } : {}) };
}

/**
 * WS-Addressing as the app's `wsaFor` builds it. The WSDL-derived default action comes from the
 * host's `defaultWsaActionFor`; without one it is empty, as it is in the app for an interface not
 * yet hydrated, and an explicit `wsa:Action` or the request's SOAPAction still applies.
 */
function wsaFor(selected: SoapSelected, context: RunContext): SoapSendInput['wsa'] {
  const config = effectiveWsa(selected.iface.wsa, selected.request.wsa);
  return config.enabled ? { config, defaultAction: context.defaultWsaActionFor?.(selected) ?? '' } : undefined;
}

/** The app's `wssFor`: a selected configuration the project no longer has refuses the send. */
function wssFor(selected: SoapSelected, context: RunContext): SoapSendWss | undefined {
  const { request } = selected;
  const pick = (id: string | undefined): string | undefined => (id === undefined || id.length === 0 ? undefined : id);
  const outgoingId = pick(request.wssOutgoingRef);
  const incomingId = pick(request.wssIncomingRef);
  if (outgoingId === undefined && incomingId === undefined) {
    return undefined;
  }
  const find = <T>(refs: Project['wss']['outgoing'], id: string, convert: (ref: (typeof refs)[number]) => T): T => {
    const ref = refs.find((candidate) => candidate.id === id);
    if (ref !== undefined) {
      try {
        return convert(ref);
      } catch {
        // An unreadable configuration is treated as the app treats it: as missing.
      }
    }
    throw new WirebenchError(
      'wss-config-missing',
      'This request selects a WS-Security configuration the project no longer has.',
      { details: { configId: id } },
    );
  };
  const outgoing =
    outgoingId === undefined ? undefined : find(context.project.wss.outgoing, outgoingId, toWssOutgoingConfig);
  const incoming =
    incomingId === undefined ? undefined : find(context.project.wss.incoming, incomingId, toWssIncomingConfig);
  const { properties } = request;
  return {
    ...(outgoing !== undefined ? { outgoing } : {}),
    ...(incoming !== undefined ? { incoming } : {}),
    ctx: createWssContext({
      keystores: (ref) => loadKeystoreById(context, ref),
      secrets: (ref) => requiredSecret(ref, context.getSecret),
    }),
    requestProperties: {
      ...(properties.wssPasswordType !== undefined ? { wssPasswordType: properties.wssPasswordType } : {}),
      ...(properties.wssTimeToLive !== undefined ? { wssTimeToLive: properties.wssTimeToLive } : {}),
    },
  };
}

/**
 * The app's `attachmentResolvers`, with the project folder as the only read boundary: a `cache`
 * attachment comes out of `attachments/`, a `path` one from its first existing candidate (resource
 * root, then the project), and an inline `file:` reference from the project folder.
 */
function attachmentResolvers(context: RunContext): AttachmentResolvers {
  const { projectDir } = context;
  const resourceRoot = context.project.settings.resourceRoot;
  const read = createFileAttachmentResolver(projectDir, resourceRoot);
  return {
    resolver: async (attachment: Attachment): Promise<Uint8Array> => {
      if (attachment.source.kind === 'path') {
        const { path } = attachment.source;
        const candidates = isAbsolute(path)
          ? [path]
          : [...(resourceRoot !== undefined ? [resolvePath(resourceRoot, path)] : []), resolvePath(projectDir, path)];
        for (const candidate of candidates) {
          const exists = await stat(candidate).then(
            () => true,
            () => false,
          );
          if (exists) {
            await insideProject(context, candidate, 'attachment-outside-project', attachment.name);
            return new Uint8Array(await readFile(candidate));
          }
        }
      }
      return read(attachment);
    },
    resolveFile: async (path: string): Promise<Uint8Array> =>
      new Uint8Array(await readFile(await insideProject(context, path, 'inline-file-outside-project', path))),
    resourceRoot: projectDir,
  };
}

/** A REST multipart file part or binary body, read from inside the project folder. */
function restFileResolver(context: RunContext): (source: AttachmentSource) => Promise<Uint8Array> {
  return async (source) =>
    source.kind === 'cache'
      ? readAttachment(context.projectDir, source.sha256)
      : new Uint8Array(
          await readFile(await insideProject(context, source.path, 'rest-file-outside-project', source.path)),
        );
}

async function prepareSoap(selected: SoapSelected, context: RunContext): Promise<PreparedSend> {
  const { iface, request } = selected;
  const resolved = resolveEndpoint(context.project, context.environmentId, iface, request);
  if (resolved.url === undefined) {
    throw new WirebenchError('endpoint-unresolved', `No endpoint resolves for "${selected.path}"`, {
      details: { path: selected.path },
    });
  }
  const owner = soapEffectiveAuth(selected);
  const base = toSendInput({
    request: {
      properties: request.properties,
      soapVersion: request.soapVersion,
      ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      headers: request.headers,
      envelopeXml: request.envelopeXml,
    },
    endpoint: resolved.url,
    projectSettings: context.project.settings,
    attachments: request.attachments,
    attachmentResolvers: attachmentResolvers(context),
  });
  const scopes = scopesFor(context);
  const tls = await tlsFor(context, request.properties.sslKeystoreRef, resolved.endpoint?.trustInvalid === true);
  const proxy = context.proxyFor?.(resolved.url);
  const wsa = wsaFor(selected, context);
  const wss = wssFor(selected, context);
  // An owner's OAuth2 gets its token as a REST one does (client credentials; the browser grant is
  // refused); the endpoint schemes resolve through the SOAP path.
  const sendAuth =
    owner !== undefined && owner.type === 'oauth2'
      ? await authFor(owner, selected.path, context, tls)
      : await resolveSoapAuth(owner, context.getSecret);
  // The attachments and MTOM options ride on `base`, as the app's `sendAttachmentsFor` builds them.
  const input: SoapSendInput = {
    ...base,
    ...(sendAuth !== undefined ? { auth: sendAuth } : {}),
    ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    ...(tls !== undefined ? { tls: { ...base.tls, ...tls } } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(wsa !== undefined ? { wsa } : {}),
    ...(wss !== undefined ? { wss } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  };
  const withTokens = await withSecrets(input, scopes, context.getSecret);
  // Refused here, before the wire: the engine would report the same refs on the exchange, but by
  // then a half-expanded envelope has already been sent to somebody's service.
  const { unresolved } = expandSendInput(input, withTokens);
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  return { kind: 'soap', input, scopes: withTokens };
}

/** The run's shared token source, or a fresh one for a `prepareSend` called on its own. */
function tokenSourceOf(context: RunContext): RunTokenSource {
  return (
    context.tokenSource ??
    createRunTokenSource({
      getSecret: context.getSecret,
      ...(context.fetchToken !== undefined ? { send: context.fetchToken } : {}),
      ...(context.onSecretValue !== undefined ? { onSecretValue: context.onSecretValue } : {}),
    })
  );
}

/**
 * A request's effective auth with its secrets resolved. OAuth2 client credentials obtains a token
 * (the token request uses the request's own TLS, the proxy for the token URL and the run's
 * timeout); the authorization-code grant needs a browser a pipeline does not have, and is refused.
 *
 * @throws WirebenchError `auth-grant-unsupported` | `secret-missing` | `unresolved-properties` |
 * `oauth2-token-error` | `oauth2-token-malformed`
 */
export async function authFor(
  configured: AuthConfig,
  path: string,
  context: RunContext,
  tls: TlsOptions | undefined,
): Promise<Awaited<ReturnType<typeof resolveAuthConfig>>> {
  if (configured.type !== 'oauth2') {
    return resolveAuthConfig(configured, context.getSecret);
  }
  if (configured.grant === 'authorization-code') {
    throw new WirebenchError(
      'auth-grant-unsupported',
      'This request signs in through a browser (OAuth2 authorization code), which a pipeline cannot do.',
      { details: { path, grant: configured.grant } },
    );
  }
  const accessToken = await tokenSourceOf(context).accessTokenFor(configured, {
    scopes: scopesFor(context),
    ...(tls !== undefined ? { tls } : {}),
    ...(context.proxyFor !== undefined ? { proxy: context.proxyFor } : {}),
    ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  return resolveAuthConfig(configured, context.getSecret, { accessToken });
}

async function prepareRest(selected: RestSelected, context: RunContext): Promise<PreparedSend> {
  const { api, request } = selected;
  const scopes = scopesFor(context);
  const tls = await tlsFor(context, request.settings.sslKeystoreRef, request.settings.trustInvalid === true);
  const auth = await authFor(restEffectiveAuth(selected), selected.path, context, tls);
  const baseUrl = resolveApiBaseUrl(context.project, context.environmentId, api).url;
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
    baseUrl,
    projectSettings: context.project.settings,
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tls } : {}),
    resolveFile: restFileResolver(context),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  const withTokens = await withSecrets(unexpanded, scopes, context.getSecret);
  const { input, unresolved } = expandRestSendInput(unexpanded, withTokens, {
    escape: request.settings.escapeProperties === true,
  });
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  // As the app does: the proxy is chosen for the base URL, or the request's own when it has none.
  const proxy = context.proxyFor?.(input.baseUrl === '' ? input.request.url : input.baseUrl);
  return {
    kind: 'rest',
    input: {
      ...input,
      ...(proxy !== undefined ? { proxy } : {}),
      ...(context.timeoutMs !== undefined ? { settings: { ...input.settings, timeoutMs: context.timeoutMs } } : {}),
    },
  };
}

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
  const target = resolveApiBaseUrl(context.project, context.environmentId, { slug: api.slug, baseUrl: api.target }).url;
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
  const withTokens = await withSecrets(withMessage, scopes, context.getSecret);
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
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing`
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
