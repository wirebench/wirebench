/**
 * Pure Node service wrapping `@wirebench/engine`: holds imported definitions and in-flight
 * sends in memory, and translates between the engine's rich types and the JSON-serialisable
 * wire shapes the IPC layer sends across the context bridge. No `electron` import — the
 * `ipc/definition.ts`/`ipc/request.ts` handlers own the `ipcMain`/`webContents` plumbing.
 */

import {
  applyWsaHeaders,
  expandSendInput,
  generateEmptyRequest,
  generateRequest,
  importDefinition as engineImportDefinition,
  normalizeWsa,
  sendSoapRequest,
  WirebenchError,
} from '@wirebench/engine';
import type {
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
} from '@wirebench/engine';
import { resolveEndpointAuth, type ResolvedAuth } from './secret-resolver.js';
import type { SendAuth } from '@wirebench/engine';
import type {
  DefinitionImportRequest,
  EngineProgressEvent,
  ExchangeSummary,
  ImportSourceWire,
  InterfaceSummary,
  RequestGenerateRequest,
  RequestGenerateResponse,
  RequestSendRequest,
  SoapSendInputWire,
  WsaConfigWire,
} from '../shared/wire-types.js';
import { redactExchangeSummary, toExchangeSummary, toGenerateResponse, toInterfaceSummary } from './engine-wire.js';
import { ExchangeCache } from './exchange-cache.js';
import type { SendAttachmentInput } from './project-service.js';

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
function toEngineTls(tls: NonNullable<SoapSendInputWire['tls']>): TlsOptions {
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
 * Converts resolved credentials into the engine's `SendAuth`, or `undefined` when there is
 * nothing to send (no auth configured, `type: 'none'`, or an incomplete pair). Basic defaults
 * to preemptive, matching SoapUI; a non-preemptive send waits for the 401 challenge.
 */
export function toEngineAuth(auth?: ResolvedAuth): SendAuth | undefined {
  if (auth === undefined || auth.type === 'none') {
    return undefined;
  }
  if (auth.username === undefined || auth.password === undefined) {
    return undefined;
  }
  if (auth.type === 'ntlm') {
    return {
      type: 'ntlm',
      username: auth.username,
      password: auth.password,
      ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
      ...(auth.workstation !== undefined ? { workstation: auth.workstation } : {}),
    };
  }
  return { type: 'basic', username: auth.username, password: auth.password, preemptive: auth.preemptive !== false };
}

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

/** Converts the wire `SoapSendInputWire` (plus a controller's signal) to the engine's `SoapSendInput`. */
function toEngineSendInput(
  input: SoapSendInputWire,
  signal: AbortSignal,
  attachments?: SendAttachmentInput,
  auth?: SendAuth,
  wss?: SoapSendWss,
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
  private readonly imports = new Map<string, AbortController>();

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
      throw new WirebenchError('secret-missing', `Secret ${wireAuth.passwordRef} was not found in the secret store.`, {
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
    this.definitions.set(id, { result, definitionUrl, loadedAt: Date.now() });
    const summary = toInterfaceSummary(result, id, definitionUrl);
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
    this.definitions.set(input.interfaceId, { result, definitionUrl, loadedAt: Date.now() });
    const summary = toInterfaceSummary(result, input.interfaceId, definitionUrl);
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
    const stored = this.definitions.get(interfaceId);
    if (stored === undefined) {
      this.lookup(interfaceId);
    }
    return stored?.loadedAt ?? 0;
  }

  private lookup(interfaceId: string): ImportResult {
    const stored = this.definitions.get(interfaceId);
    if (stored === undefined) {
      throw new WirebenchError('unknown-interface', `No imported interface with id "${interfaceId}"`, {
        details: { interfaceId },
      });
    }
    return stored.result;
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
    request: RequestSendRequest,
    options: {
      scopes?: PropertyScopes;
      auth?: EndpointAuth;
      showSecrets?: boolean;
      /** The saved request's attachments and MTOM options; absent for an ad-hoc send. */
      attachments?: SendAttachmentInput;
      /** The request's outgoing WS-Security configuration and its context; absent when it selects none. */
      wss?: SoapSendWss;
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
}
