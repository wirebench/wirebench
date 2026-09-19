/**
 * Pure Node service wrapping `@wirebench/engine`: holds imported definitions and in-flight
 * sends in memory, and translates between the engine's rich types and the JSON-serialisable
 * wire shapes the IPC layer sends across the context bridge. No `electron` import — the
 * `ipc/definition.ts`/`ipc/request.ts` handlers own the `ipcMain`/`webContents` plumbing.
 */

import {
  callGrpc,
  sendRest,
  applyWsaHeaders,
  expandSendInput,
  generateEmptyRequest,
  generateRequest,
  importDefinition as engineImportDefinition,
  normalizeWsa,
  openWsSession,
  sendSoapRequest,
  toSendAuth,
  WirebenchError,
} from '@wirebench/engine';
import type {
  AuthConfig,
  GrpcCallStreamHandle,
  GrpcResponseMessage,
  GrpcSendInput,
  ProtoSet,
  RestSendInput,
  EndpointAuth,
  GenerateOptions,
  ImportProgress,
  ImportResult,
  ImportSource,
  PropertyScopes,
  QName,
  SoapSendInput,
  SoapSendWss,
  TlsOptions,
  WsaConfigPatch,
  WsSessionHandle,
  WsSessionOptions,
} from '@wirebench/engine';
import { resolveAuthConfig, resolveEndpointAuth, secretMissingMessage, type ResolvedAuth } from './secret-resolver.js';
import type { FetchDocument, SendAuth } from '@wirebench/engine';
import type {
  GrpcExchangeSummary,
  GrpcLiveEvent,
  RequestGrpcPushResponse,
  RestExchangeSummary,
  DefinitionImportRequest,
  EngineProgressEvent,
  ExchangeSummary,
  ImportSourceWire,
  InterfaceSummary,
  ProxyOptionsWire,
  RequestGenerateRequest,
  RequestGenerateResponse,
  ResolvedSendInputWire,
  ResolvedSendRequest,
  SoapSendInputWire,
  TlsOptionsWire,
  WsaConfigWire,
  WsExchangeSummary,
  WsFrameWire,
  WsLiveEvent,
} from '../shared/wire-types.js';
import {
  toGrpcExchangeSummary,
  toGrpcResponseMessageWire,
  toRestExchangeSummary,
  redactExchangeSummary,
  toExchangeSummary,
  toGenerateResponse,
  toInterfaceSummary,
  toWsExchangeSummary,
  toWsFrameWire,
  toWsHandshakeWire,
} from './engine-wire.js';
import { ExchangeCache } from './exchange-cache.js';
import type { SendAttachmentInput } from './project-host.js';

/** One imported definition kept in memory, alongside the location it was resolved from. */
interface StoredDefinition {
  readonly result: ImportResult;
  readonly definitionUrl: string;
  /** Epoch milliseconds at which this definition was loaded into memory — the Interface editor's "last import". */
  readonly loadedAt: number;
}

/** Hooks the IPC layer supplies so `EngineService` never has to know about `ipcMain`/`webContents`. */
export interface EngineServiceHooks {
  readonly onProgress?: (event: EngineProgressEvent) => void;
}

/** Parses a Clark-notation QName string (`{namespaceUri}localName`) back into a `QName`. */
function parseClarkQName(clark: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  if (match === null) {
    throw new WirebenchError('invalid-qname', `"${clark}" is not a valid Clark-notation QName`, {
      details: { qname: clark },
    });
  }
  const [, namespaceUri, localName] = match;
  return { namespaceUri: namespaceUri ?? '', localName: localName ?? '' };
}

/**
 * Converts the wire `ImportSourceWire` to the engine's `ImportSource`. Needed because a zod
 * `.optional()` field infers as `T | undefined` under `exactOptionalPropertyTypes`, which
 * cannot be assigned directly to the engine's `field?: T` (no explicit `undefined`).
 */
function toEngineSource(source: ImportSourceWire): ImportSource {
  if (source.kind === 'text') {
    return { kind: 'text', text: source.text, ...(source.location !== undefined ? { location: source.location } : {}) };
  }
  return source;
}

/** Converts wire-shaped generate options to the engine's `Partial<GenerateOptions>`, dropping `undefined` keys. */
function toEngineGenerateOptions(options: RequestGenerateRequest['options']): Partial<GenerateOptions> | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...(options.includeOptional !== undefined ? { includeOptional: options.includeOptional } : {}),
    ...(options.sampleValues !== undefined ? { sampleValues: options.sampleValues } : {}),
    ...(options.typeComments !== undefined ? { typeComments: options.typeComments } : {}),
  };
}

/** Converts wire-shaped TLS options to the engine's `TlsOptions`, dropping `undefined` keys. */
function toEngineTls(tls: TlsOptionsWire): TlsOptions {
  return {
    ...(tls.rejectUnauthorized !== undefined ? { rejectUnauthorized: tls.rejectUnauthorized } : {}),
    ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
    ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
    ...(tls.key !== undefined ? { key: tls.key } : {}),
    ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}),
    ...(tls.minVersion !== undefined ? { minVersion: tls.minVersion } : {}),
    ...(tls.servername !== undefined ? { servername: tls.servername } : {}),
  };
}

/**
 * When `auth.type === 'basic'` and `auth.preemptive !== false`, adds an `Authorization: Basic
 * ...` header to `input`. Only the cURL export path uses this now: a real send hands the
 * credentials to the engine (see {@link toEngineAuth}), which also handles the 401 challenge,
 * but an exported cURL command has no challenge loop and so needs the preemptive header baked
 * in. An explicit header the caller already set is left alone. Pure — takes the *resolved*
 * auth (a real password, never a ref) — so it is trivially unit-testable without IPC or a
 * secret store.
 */
export function withResolvedAuth(input: SoapSendInputWire, auth?: ResolvedAuth): SoapSendInputWire {
  if (auth === undefined || auth.type !== 'basic' || auth.preemptive === false) {
    return input;
  }
  if (auth.username === undefined || auth.password === undefined) {
    return input;
  }
  const headers = { ...input.headers };
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    return input;
  }
  headers['Authorization'] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
  return { ...input, headers };
}

/**
 * Converts resolved credentials into the engine's `SendAuth`. The mapping lives in the engine
 * (`toSendAuth`) so the CLI runner authenticates exactly as the app does; this is its old name.
 */
export const toEngineAuth = toSendAuth;

/**
 * Drops the explicitly-`undefined` keys a zod-parsed optional leaves behind, so the result is
 * assignable to the engine's `WsaConfigPatch` under `exactOptionalPropertyTypes`.
 */
function stripUndefined(value: WsaConfigWire): WsaConfigPatch {
  const patch: WsaConfigPatch = {};
  return Object.entries(value).reduce<WsaConfigPatch>(
    (accumulated, [key, entry]) => (entry === undefined ? accumulated : { ...accumulated, [key]: entry }),
    patch,
  );
}

/**
 * Converts a send input (plus a controller's signal) to the engine's `SoapSendInput`.
 *
 * The input is the *resolved* one: the wire shape only carries `tls.minVersion`, and every
 * other TLS field has been added by main from the CA-bundle preference, the selected keystore
 * and the endpoint's `trustInvalid`.
 */
function toEngineSendInput(
  input: ResolvedSendInputWire,
  signal: AbortSignal,
  attachments?: SendAttachmentInput,
  auth?: SendAuth,
  wss?: SoapSendWss,
  proxy?: ProxyOptionsWire,
): SoapSendInput {
  return {
    endpoint: input.endpoint,
    envelopeXml: input.envelopeXml,
    soapVersion: input.soapVersion,
    ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
    ...(input.followRedirects !== undefined ? { followRedirects: input.followRedirects } : {}),
    ...(input.maxSizeBytes !== undefined ? { maxSizeBytes: input.maxSizeBytes } : {}),
    ...(input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {}),
    ...(input.localAddress !== undefined ? { localAddress: input.localAddress } : {}),
    ...(input.compressBody !== undefined ? { compressBody: input.compressBody } : {}),
    ...(input.entitize !== undefined ? { entitize: input.entitize } : {}),
    ...(input.tls !== undefined ? { tls: toEngineTls(input.tls) } : {}),
    ...(input.allowH2 !== undefined ? { allowH2: input.allowH2 } : {}),
    ...(proxy !== undefined
      ? { proxy: { url: proxy.url, ...(proxy.auth !== undefined ? { auth: proxy.auth } : {}) } }
      : {}),
    // WS-Addressing carries no secret and no closure, so — unlike WS-Security — it rides on the
    // wire input the renderer built and only needs its optionals normalised here.
    ...(input.wsa !== undefined
      ? { wsa: { config: normalizeWsa(stripUndefined(input.wsa.config)), defaultAction: input.wsa.defaultAction } }
      : {}),
    // Attachments never cross IPC (the resolvers are closures over main's file system), so they
    // are folded in here rather than carried on `SoapSendInputWire`.
    ...(attachments !== undefined
      ? { attachments: attachments.attachments, attachmentOptions: attachments.attachmentOptions }
      : {}),
    ...(auth !== undefined ? { auth } : {}),
    // Same reason as attachments: the context closes over main's keystores and secret store,
    // so it can only be folded in here, never carried on `SoapSendInputWire`.
    ...(wss !== undefined ? { wss } : {}),
    signal,
  };
}

/** Human-readable message for one `ImportProgress` phase, shown in the UI while an import runs. */
function messageFor(progress: ImportProgress): string {
  switch (progress.phase) {
    case 'fetch':
      return `Fetching ${progress.location}`;
    case 'parse':
      return 'Parsing WSDL';
    case 'schema':
      return 'Compiling schemas';
    case 'done':
      return 'Import complete';
  }
}

/**
 * In-process engine facade for the desktop app: imports definitions (keyed by a generated
 * id), generates sample/empty requests against them, and sends SOAP requests with
 * cancellation support via a per-send `AbortController`.
 */
export class EngineService {
  private readonly definitions = new Map<string, StoredDefinition>();
  private readonly sends = new Map<string, AbortController>();

  /**
   * The open interactive gRPC calls, by send id. An entry lives only while the engine holds that
   * call's request side open, so a push or a half-close for a call that has ended is answered
   * rather than written to a dead stream.
   */
  private readonly grpcStreams = new Map<string, GrpcCallStreamHandle>();
  private readonly imports = new Map<string, AbortController>();

  /**
   * The open WebSocket sessions, by send id. An entry lives only from a successful handshake
   * (`handshake.status === 101`) until the session closes, so {@link sendWsMessage} and
   * {@link closeWs} answer `ws-session-unknown`/`{ closed: false }` for a session that never
   * opened or has already ended, rather than writing to a dead socket.
   */
  private readonly wsSessions = new Map<string, WsSessionHandle>();

  /**
   * The unredacted summaries of recent sends, kept in main so the show-secrets toggle can
   * re-render an already-logged exchange (`exchanges.get`) without the renderer ever holding
   * the unredacted bytes.
   */
  readonly exchanges = new ExchangeCache();

  /**
   * Resolves a `secretRef` for {@link importDefinition}'s Basic-auth fetch credentials. Omitted
   * in tests that never import with auth; `main/index.ts` wires it to `SecretStore.get`.
   */
  constructor(private readonly getSecret?: (ref: string) => Promise<string | undefined>) {}

  /** Imports a WSDL definition and stores the full `ImportResult` under a new id. */
  async importDefinition(request: DefinitionImportRequest, hooks: EngineServiceHooks = {}): Promise<InterfaceSummary> {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    if (request.token !== undefined) {
      this.imports.set(request.token, controller);
    }
    const wireAuth = request.options?.auth;
    const password = wireAuth !== undefined ? await this.getSecret?.(wireAuth.passwordRef) : undefined;
    if (wireAuth !== undefined && password === undefined) {
      throw new WirebenchError('secret-missing', secretMissingMessage(wireAuth.username), {
        details: { ref: wireAuth.passwordRef },
      });
    }
    let result: ImportResult;
    try {
      result = await engineImportDefinition(toEngineSource(request.source), {
        ...(wireAuth !== undefined && password !== undefined
          ? { auth: { username: wireAuth.username, password } }
          : {}),
        signal: controller.signal,
        onProgress: (progress) => {
          // The final 'done' event is re-emitted below once the interface id is known, so the
          // renderer's `phase === 'done'` handler always sees an `interfaceId`.
          if (progress.phase === 'done') {
            return;
          }
          hooks.onProgress?.({
            kind: 'import',
            ...(request.token !== undefined ? { token: request.token } : {}),
            phase: progress.phase,
            message: messageFor(progress),
          });
        },
      });
    } finally {
      if (request.token !== undefined) {
        this.imports.delete(request.token);
      }
    }
    const definitionUrl = result.bundle.root.location;
    const loadedAt = Date.now();
    this.definitions.set(id, { result, definitionUrl, loadedAt });
    const summary = { ...toInterfaceSummary(result, id, definitionUrl), loadedAt };
    hooks.onProgress?.({
      kind: 'import',
      interfaceId: id,
      ...(request.token !== undefined ? { token: request.token } : {}),
      phase: 'done',
      message: messageFor({ phase: 'done' }),
    });
    return summary;
  }

  /**
   * Imports a definition *without* storing it: the preview half of Update Definition, which
   * must not replace the interface's live result until the user actually applies the plan.
   * No cache is touched either — a plan the user cancels leaves nothing behind.
   */
  async importPreview(
    source: ImportSourceWire,
    auth?: { readonly username: string; readonly password: string },
    signal?: AbortSignal,
  ): Promise<ImportResult> {
    return engineImportDefinition(toEngineSource(source), {
      ...(auth !== undefined ? { auth } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /**
   * Imports a definition on behalf of an open project: the caller supplies the interface id
   * (the project model owns it) and the definition-cache directory, so a reopened project can
   * re-hydrate from `interfaces/<slug>/definition/` without touching the network.
   */
  async importForProject(
    input: {
      readonly interfaceId: string;
      readonly source: ImportSourceWire;
      readonly cache: { readonly dir: string; readonly mode: 'prefer-cache' | 'refresh' | 'none' };
      readonly auth?: { readonly username: string; readonly password: string };
      readonly token?: string;
      /**
       * Where every document is read from, in place of the network. Main-side only — it never
       * crosses IPC. A legacy project import passes one that answers from the file's own copy of
       * the definition.
       */
      readonly fetchDocument?: FetchDocument;
    },
    hooks: EngineServiceHooks = {},
  ): Promise<InterfaceSummary> {
    const controller = new AbortController();
    if (input.token !== undefined) {
      this.imports.set(input.token, controller);
    }
    let result: ImportResult;
    try {
      result = await engineImportDefinition(toEngineSource(input.source), {
        ...(input.auth !== undefined ? { auth: input.auth } : {}),
        ...(input.fetchDocument !== undefined ? { fetchDocument: input.fetchDocument } : {}),
        cache: input.cache,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'done') {
            return;
          }
          hooks.onProgress?.({
            kind: 'import',
            interfaceId: input.interfaceId,
            ...(input.token !== undefined ? { token: input.token } : {}),
            phase: progress.phase,
            message: messageFor(progress),
          });
        },
      });
    } finally {
      if (input.token !== undefined) {
        this.imports.delete(input.token);
      }
    }
    const definitionUrl = result.bundle.root.location;
    const loadedAt = Date.now();
    this.definitions.set(input.interfaceId, { result, definitionUrl, loadedAt });
    const summary = { ...toInterfaceSummary(result, input.interfaceId, definitionUrl), loadedAt };
    hooks.onProgress?.({
      kind: 'import',
      interfaceId: input.interfaceId,
      ...(input.token !== undefined ? { token: input.token } : {}),
      phase: 'done',
      message: messageFor({ phase: 'done' }),
    });
    return summary;
  }

  /**
   * Adopts `result` (already fetched via {@link importPreview}) as `interfaceId`'s live
   * definition, without fetching or touching the definition cache itself. Used by Update
   * Definition once the project save it depends on has actually succeeded — see
   * `ProjectHost.applyDefinitionUpdate`, which fetches the preview, saves, and only then
   * calls this to make the new definition live.
   */
  commitResult(interfaceId: string, result: ImportResult, definitionUrl: string): InterfaceSummary {
    const loadedAt = Date.now();
    this.definitions.set(interfaceId, { result, definitionUrl, loadedAt });
    return { ...toInterfaceSummary(result, interfaceId, definitionUrl), loadedAt };
  }

  /**
   * The input a send would actually put on the wire: the effective Basic-auth header applied
   * (its `passwordRef` resolved), every `${#…#name}` reference expanded, and — when the request
   * has WS-Addressing enabled — its `wsa:*` headers applied to the envelope, exactly as
   * `sendSoapRequest` does. Shared by `request.curl`, which must show the very same command
   * `request.send` would perform, modulo two layers it deliberately omits: WS-Security (which
   * needs secrets and a keystore this method never touches) and attachments (which never ride
   * on the wire input at all, see `toEngineSendInput`) — a caller quoting the exported command
   * must say so itself. A `messageId: 'auto'` mints a fresh UUID here, so the exported command
   * carries a one-off MessageID that will not match the one an actual send produces.
   *
   * Unresolved property references are left as written rather than reported, since nothing is
   * sent.
   */
  async effectiveSendInput(
    input: SoapSendInputWire,
    options: { scopes?: PropertyScopes; auth?: EndpointAuth } = {},
  ): Promise<SoapSendInputWire> {
    const resolvedAuth =
      options.auth !== undefined
        ? await resolveEndpointAuth(options.auth, (ref) => this.getSecret?.(ref) ?? Promise.resolve(undefined))
        : undefined;
    const withAuth = withResolvedAuth(input, resolvedAuth);
    if (options.scopes === undefined) {
      return this.applyWsaForPreview(withAuth);
    }
    const expanded = expandSendInput(toEngineSendInput(withAuth, new AbortController().signal), options.scopes).input;
    return this.applyWsaForPreview({
      ...withAuth,
      endpoint: expanded.endpoint,
      envelopeXml: expanded.envelopeXml,
      ...(expanded.soapAction !== undefined ? { soapAction: expanded.soapAction } : {}),
      ...(expanded.headers !== undefined ? { headers: { ...expanded.headers } } : {}),
    });
  }

  /**
   * Bakes `input.wsa`'s headers into `input.envelopeXml`, the way `sendSoapRequest` would —
   * used by {@link effectiveSendInput} so the cURL export's envelope carries the same `wsa:*`
   * headers an actual send puts on the wire. A no-op when WS-Addressing is absent or disabled.
   */
  private applyWsaForPreview(input: SoapSendInputWire): SoapSendInputWire {
    if (input.wsa === undefined || !input.wsa.config.enabled) {
      return input;
    }
    const envelopeXml = applyWsaHeaders(input.envelopeXml, normalizeWsa(stripUndefined(input.wsa.config)), {
      endpoint: input.endpoint,
      ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
      defaultAction: input.wsa.defaultAction,
      uuid: () => crypto.randomUUID(),
      envelopeVersion: input.soapVersion,
    });
    return { ...input, envelopeXml };
  }

  /** True when a definition is loaded in memory for `interfaceId`. */
  has(interfaceId: string): boolean {
    return this.definitions.has(interfaceId);
  }

  /** Aborts the in-flight import for `token`. Returns `false` when no such import is pending. */
  cancelImport(token: string): { cancelled: boolean } {
    const controller = this.imports.get(token);
    if (controller === undefined) {
      return { cancelled: false };
    }
    controller.abort();
    this.imports.delete(token);
    return { cancelled: true };
  }

  /** Frees the in-memory `ImportResult` for `interfaceId`. */
  close(interfaceId: string): { closed: boolean } {
    return { closed: this.definitions.delete(interfaceId) };
  }

  /** The resolved `SchemaSet` for `interfaceId`, for completion/declaration lookups. Throws `unknown-interface` if absent. */
  schemaSetFor(interfaceId: string) {
    return this.lookup(interfaceId).schemaSet;
  }

  /** The whole in-memory `ImportResult` for `interfaceId`. Throws `unknown-interface` if absent. */
  resultFor(interfaceId: string): ImportResult {
    return this.lookup(interfaceId);
  }

  /** When `interfaceId`'s definition was last loaded into memory (epoch ms). Throws `unknown-interface` if absent. */
  loadedAtFor(interfaceId: string): number {
    return this.lookupStored(interfaceId).loadedAt;
  }

  private lookup(interfaceId: string): ImportResult {
    return this.lookupStored(interfaceId).result;
  }

  /** The whole cache entry for `interfaceId`, or `unknown-interface` when nothing is loaded. */
  private lookupStored(interfaceId: string): StoredDefinition {
    const stored = this.definitions.get(interfaceId);
    if (stored === undefined) {
      throw new WirebenchError('unknown-interface', `No imported interface with id "${interfaceId}"`, {
        details: { interfaceId },
      });
    }
    return stored;
  }

  /** Builds a sample (or, with `empty: true`, blank) SOAP request for one operation. */
  generate(request: RequestGenerateRequest): RequestGenerateResponse {
    const result = this.lookup(request.interfaceId);
    const opRef = { bindingName: parseClarkQName(request.bindingName), operationName: request.operationName };
    const generated =
      request.empty === true
        ? generateEmptyRequest(result, opRef)
        : generateRequest(result, opRef, toEngineGenerateOptions(request.options));
    return toGenerateResponse(generated);
  }

  /**
   * Sends a SOAP request, registering an `AbortController` so a matching `cancel` can abort it.
   *
   * With `options.scopes` the engine expands `${...}` property references in the endpoint,
   * envelope, SOAPAction and headers first, and reports whatever stayed unresolved on the
   * returned summary's `unresolved`.
   */
  async send(
    request: ResolvedSendRequest,
    options: {
      scopes?: PropertyScopes;
      auth?: EndpointAuth;
      showSecrets?: boolean;
      /** The saved request's attachments and MTOM options; absent for an ad-hoc send. */
      attachments?: SendAttachmentInput;
      /** The request's outgoing WS-Security configuration and its context; absent when it selects none. */
      wss?: SoapSendWss;
      /**
       * The proxy this send must go through, already resolved (and its password already
       * decrypted) by `ProjectHost.proxyFor`. Deliberately an option rather than a field of
       * `SoapSendInputWire`: a renderer must be able neither to name a proxy nor to see the
       * credentials for one.
       */
      proxy?: ProxyOptionsWire;
    } = {},
  ): Promise<ExchangeSummary> {
    const controller = new AbortController();
    this.sends.set(request.sendId, controller);
    try {
      const resolvedAuth =
        options.auth !== undefined
          ? await resolveEndpointAuth(options.auth, (ref) => this.getSecret?.(ref) ?? Promise.resolve(undefined))
          : undefined;
      // The credentials go to the engine rather than being baked into a header here, so the
      // engine can run the 401-challenge retry when they are not preemptive.
      const exchange = await sendSoapRequest(
        toEngineSendInput(
          request.input,
          controller.signal,
          options.attachments,
          toEngineAuth(resolvedAuth),
          options.wss,
          options.proxy,
        ),
        {
          ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
        },
      );
      // The cache keeps the unredacted summary in main only; what crosses IPC is redacted per
      // the flag as it stands right now (`exchanges.get` re-redacts on a later toggle). The
      // response attachments' BYTES are kept alongside it, never on the wire — `attachments.*`
      // reads them back from here by `sendId` + index.
      const full = toExchangeSummary(exchange, request.sendId, { show: true });
      this.exchanges.put(request.sendId, full, exchange.response?.attachments, {
        exchange,
        ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
        requestEnvelopeXml: request.input.envelopeXml,
      });
      return redactExchangeSummary(full, { show: options.showSecrets ?? false });
    } finally {
      this.sends.delete(request.sendId);
    }
  }

  /**
   * Sends a REST request, registering an `AbortController` so a matching `cancel` can abort it.
   *
   * The input arrives fully resolved (`rest-send.ts`): base URL, properties, credentials, TLS and
   * proxy are all settled before this is called, so this method only runs the exchange and projects
   * the result. The unredacted summary stays in main's cache; what crosses IPC is redacted per the
   * session's flag, exactly as a SOAP send's is.
   */
  async sendRestRequest(
    request: { readonly sendId: string; readonly requestId: string; readonly input: RestSendInput },
    options: {
      readonly showSecrets?: boolean;
      readonly keyParams?: readonly string[];
      /** The credentials as configured, still references; resolved here, as a SOAP send's are. */
      readonly auth?: AuthConfig;
      /** An OAuth2 access token the host already obtained; never read from the secret store. */
      readonly accessToken?: string;
    } = {},
  ): Promise<RestExchangeSummary> {
    const controller = new AbortController();
    this.sends.set(request.sendId, controller);
    try {
      const auth = await resolveAuthConfig(
        options.auth,
        (ref) => this.getSecret?.(ref) ?? Promise.resolve(undefined),
        options.accessToken !== undefined ? { accessToken: options.accessToken } : {},
      );
      const exchange = await sendRest({
        ...request.input,
        ...(auth !== undefined ? { auth } : {}),
        signal: controller.signal,
      });
      const context = {
        method: request.input.request.method,
        ...(options.keyParams !== undefined ? { keyParams: options.keyParams } : {}),
      };
      const full = toRestExchangeSummary(exchange, request.sendId, { ...context, show: true });
      this.exchanges.putRest(request.sendId, full, exchange.body, (show) =>
        toRestExchangeSummary(exchange, request.sendId, { ...context, show }),
      );
      return toRestExchangeSummary(exchange, request.sendId, { ...context, show: options.showSecrets ?? false });
    } finally {
      this.sends.delete(request.sendId);
    }
  }

  /**
   * Makes one gRPC call, registering an `AbortController` so a matching `cancel` can abort it.
   *
   * The input arrives resolved (`grpc-send.ts`) and the `.proto` set loaded (the project host keeps
   * it); credentials are resolved here from their references, as for the other two protocols, and
   * the message text is encoded against the method's request type by the engine.
   *
   * `options.onLive` is told what arrives while the call runs — the initial metadata and each
   * decoded message — and `options.interactive` keeps the request side open, registering the call's
   * handle so {@link pushGrpcMessage} and {@link halfCloseGrpc} can drive it by the same `sendId`.
   * Neither changes what this resolves with: the whole exchange, once the call has ended.
   */
  async sendGrpcRequest(
    request: {
      readonly sendId: string;
      readonly requestId: string;
      readonly set: ProtoSet;
      readonly input: Omit<GrpcSendInput, 'messages' | 'onHeaders' | 'onMessage' | 'onOpen'>;
      readonly messageText: string;
    },
    options: {
      readonly showSecrets?: boolean;
      readonly auth?: AuthConfig;
      readonly accessToken?: string;
      readonly interactive?: boolean;
      readonly onLive?: (event: GrpcLiveEvent) => void;
    } = {},
  ): Promise<GrpcExchangeSummary> {
    const controller = new AbortController();
    this.sends.set(request.sendId, controller);
    const { sendId } = request;
    const onLive = options.onLive;
    try {
      const auth = await resolveAuthConfig(
        options.auth,
        (ref) => this.getSecret?.(ref) ?? Promise.resolve(undefined),
        options.accessToken !== undefined ? { accessToken: options.accessToken } : {},
      );
      const result = await callGrpc({
        ...request.input,
        set: request.set,
        messageText: request.messageText,
        ...(auth !== undefined ? { auth } : {}),
        signal: controller.signal,
        ...(onLive !== undefined
          ? {
              onHeaders: (headers: Readonly<Record<string, string>>, httpStatus: number): void => {
                onLive({ kind: 'headers', sendId, httpStatus, headers: { ...headers } });
              },
              onMessage: (message: GrpcResponseMessage, index: number): void => {
                onLive({ kind: 'message', sendId, index, message: toGrpcResponseMessageWire(message) });
              },
            }
          : {}),
        ...(options.interactive === true
          ? {
              onOpen: (handle: GrpcCallStreamHandle): void => {
                this.grpcStreams.set(sendId, handle);
                onLive?.({ kind: 'open', sendId });
              },
            }
          : {}),
      });
      return toGrpcExchangeSummary(result, sendId, { show: options.showSecrets ?? false });
    } finally {
      this.sends.delete(sendId);
      this.grpcStreams.delete(sendId);
    }
  }

  /**
   * Writes one more message on the interactive gRPC call `sendId`, returning it as it went.
   *
   * @throws WirebenchError `grpc-stream-unknown` when no interactive call with that id is open;
   * whatever the engine throws for text that does not encode against the request type
   */
  pushGrpcMessage(sendId: string, messageText: string): RequestGrpcPushResponse {
    const handle = this.grpcStreams.get(sendId);
    if (handle === undefined) {
      throw new WirebenchError('grpc-stream-unknown', 'That call is no longer open for sending.', {
        details: { sendId },
      });
    }
    return { json: JSON.stringify(handle.send(messageText), null, 2) };
  }

  /** Half-closes the interactive gRPC call `sendId`. `false` when no such call is open. */
  halfCloseGrpc(sendId: string): { closed: boolean } {
    const handle = this.grpcStreams.get(sendId);
    if (handle === undefined) {
      return { closed: false };
    }
    handle.end();
    this.grpcStreams.delete(sendId);
    return { closed: true };
  }

  /** Aborts the in-flight send for `sendId`. Returns `false` when no such send is pending. */
  cancel(sendId: string): { cancelled: boolean } {
    const controller = this.sends.get(sendId);
    if (controller === undefined) {
      return { cancelled: false };
    }
    controller.abort();
    this.sends.delete(sendId);
    return { cancelled: true };
  }

  /**
   * Opens one WebSocket session and drives it by `sendId`, the twin of {@link sendGrpcRequest}'s
   * live-streaming shape: this stays pending for the life of the session — handshake through
   * close — and resolves with the whole exchange, while `options.onLive` reports the handshake
   * and each frame as they happen.
   *
   * An `AbortController` is registered in the same `sends` map a REST/gRPC send uses, so
   * `request.cancel` can abort a handshake in progress; its signal is passed into the session
   * options. The handle is added to `wsSessions` only once the handshake actually succeeds
   * (`handshake.status === 101`) — a refused handshake never becomes a session `sendWsMessage`
   * or `closeWs` could address. `openWsSession` itself never rejects `done`; a synchronous
   * `ws-bad-options` throw (a malformed URL, an illegal subprotocol) propagates as a rejected
   * invoke instead, since that is a bad option, not a server result — both paths clean up `sends`.
   */
  async openWsSession(
    args: { readonly sendId: string; readonly requestId: string; readonly options: Omit<WsSessionOptions, 'signal'> },
    o: {
      readonly showSecrets?: boolean;
      readonly keyParams?: readonly string[];
      readonly onLive?: (event: WsLiveEvent) => void;
    } = {},
  ): Promise<WsExchangeSummary> {
    const { sendId } = args;
    // A reused `sendId` must never overwrite a session already in flight: silently replacing the
    // map entry would orphan the first session — nothing could `sendWsMessage`/`closeWs` it again,
    // and its own `finally` would delete whatever the *second* open just installed. Refused before
    // either map is touched, so the first session's entries are left exactly as they were.
    if (this.sends.has(sendId) || this.wsSessions.has(sendId)) {
      throw new WirebenchError('ws-session-exists', 'That connection is already open.', { details: { sendId } });
    }
    const controller = new AbortController();
    this.sends.set(sendId, controller);
    const onLive = o.onLive;
    const show = o.showSecrets ?? false;
    const wireOpts = { show, ...(o.keyParams !== undefined ? { keyParams: o.keyParams } : {}) };
    // A live event that cannot be delivered (the renderer window is gone, or — a programming
    // error — the payload does not match its schema, which `emitEvent` throws on by design) must
    // never affect the session itself: it is only ever told *what happened*, never asked to allow
    // it. Every call is guarded so a throw here can't leave `onClosed` unresolved, which would hang
    // this invoke forever (the engine's `settle()` calls `onClosed` before resolving `done`).
    const safeOnLive = (event: WsLiveEvent): void => {
      try {
        onLive?.(event);
      } catch (error) {
        console.warn(
          `[ws] a live event ("${event.kind}") for send "${sendId}" could not be delivered: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    // Declared before the session is opened so the hooks below never see a temporal-dead-zone
    // reference to it, in case the engine were ever to call a hook synchronously.
    let handle: WsSessionHandle;
    try {
      handle = openWsSession(
        { ...args.options, signal: controller.signal },
        {
          onHandshake: (handshake) => {
            if (handshake.status === 101) {
              this.wsSessions.set(sendId, handle);
            }
            safeOnLive({ kind: 'handshake', sendId, handshake: toWsHandshakeWire(handshake, wireOpts) });
          },
          onFrame: (frame) => {
            safeOnLive({ kind: 'frame', sendId, frame: toWsFrameWire(frame) });
          },
          onClosed: () => {
            safeOnLive({ kind: 'closed', sendId });
          },
        },
      );
      const exchange = await handle.done;
      return toWsExchangeSummary(exchange, sendId, wireOpts);
    } finally {
      this.sends.delete(sendId);
      this.wsSessions.delete(sendId);
    }
  }

  /**
   * Writes one more message on the open WebSocket session `sendId`, returning the frame as it went.
   *
   * @throws WirebenchError `ws-session-unknown` when no session with that id is open
   */
  sendWsMessage(sendId: string, message: { readonly text: string } | { readonly base64: string }): WsFrameWire {
    const handle = this.wsSessions.get(sendId);
    if (handle === undefined) {
      throw new WirebenchError('ws-session-unknown', 'That connection is no longer open.', { details: { sendId } });
    }
    const data = 'text' in message ? message.text : Buffer.from(message.base64, 'base64');
    return toWsFrameWire(handle.send(data));
  }

  /** Closes the WebSocket session `sendId`. `false` when no such session is open. */
  closeWs(sendId: string, code?: number, reason?: string): { closed: boolean } {
    const handle = this.wsSessions.get(sendId);
    if (handle === undefined) {
      return { closed: false };
    }
    handle.close(code, reason);
    // Removed eagerly, like `halfCloseGrpc` removes its call: once `close()` has been asked for,
    // a second `closeWs` for the same `sendId` must answer `false`, not wait for the socket to
    // actually finish closing — `openWsSession`'s own `finally` also deletes this entry, which is
    // then a harmless no-op.
    this.wsSessions.delete(sendId);
    return { closed: true };
  }

  /**
   * Closes every open WebSocket session. An application may not send 1001 on the wire (RFC 6455
   * §7.4.1), so this always sends `1000 'going away'`; a caller that wants 1001 recorded (e.g. a
   * History row for "the app is quitting") records it itself alongside this call.
   */
  closeAllWs(): void {
    for (const [sendId, handle] of this.wsSessions) {
      // One session refusing to close (an already-closing socket throwing on a second close,
      // say) must not stop the rest of them from being asked to close too.
      try {
        handle.close(1000, 'going away');
      } catch (error) {
        console.warn(
          `[ws] closeAllWs: closing "${sendId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
