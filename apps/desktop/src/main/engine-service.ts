/**
 * Pure Node service wrapping `@wirebench/engine`: holds imported definitions in memory, and
 * translates between the engine's rich types and the JSON-serialisable wire shapes the IPC layer
 * sends across the context bridge. Sending is not here: every send goes through
 * `send/exchange.ts` (`sendThroughEngine`). No `electron` import — the
 * `ipc/definition.ts`/`ipc/request.ts` handlers own the `ipcMain`/`webContents` plumbing.
 */

import {
  generateEmptySoapRequest,
  generateSoapRequest,
  importWsdl as engineImportDefinition,
  WirebenchError,
} from '@wirebench/engine';
import type { GenerateOptions, WsdlImportProgress, WsdlImportResult, WsdlImportSource, QName } from '@wirebench/engine';
import { secretMissingMessage } from './secret-resolver.js';
import type { FetchDocument, KerberosSendAuth } from '@wirebench/engine';
import {
  createRestContractChecker,
  DEFAULT_REST_CHECK_DEADLINE_MS,
  type RestContractChecker,
  type RestContractInput,
  type RestContractResult,
} from '@wirebench/engine';
import type {
  DefinitionImportRequest,
  EngineProgressEvent,
  ImportSourceWire,
  InterfaceSummary,
  RequestGenerateRequest,
  RequestGenerateResponse,
} from '../shared/wire-types.js';
import { toGenerateResponse, toInterfaceSummary } from './engine-wire.js';
import { ExchangeCache } from './exchange-cache.js';

/** One imported definition kept in memory, alongside the location it was resolved from. */
interface StoredDefinition {
  readonly result: WsdlImportResult;
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
 * Converts the wire `ImportSourceWire` to the engine's `WsdlImportSource`. Needed because a zod
 * `.optional()` field infers as `T | undefined` under `exactOptionalPropertyTypes`, which
 * cannot be assigned directly to the engine's `field?: T` (no explicit `undefined`).
 */
function toEngineSource(source: ImportSourceWire): WsdlImportSource {
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

/** Human-readable message for one `WsdlImportProgress` phase, shown in the UI while an import runs. */
function messageFor(progress: WsdlImportProgress): string {
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
 * id), generates sample/empty requests against them, keeps the unredacted exchanges of recent
 * sends, and runs the app's REST contract checker.
 */
export class EngineService {
  private readonly definitions = new Map<string, StoredDefinition>();
  private readonly imports = new Map<string, AbortController>();
  /**
   * The one REST response checker of the app, started by the first response that has a contract
   * to be checked against and ended on quit or when the workspace closes
   * ({@link disposeRestContractChecker}); the next check after that starts a fresh one.
   */
  private restChecker: RestContractChecker | undefined;
  /** How long a send waits for its contract check, lookup included; tests shorten it. */
  restContractDeadlineMs = DEFAULT_REST_CHECK_DEADLINE_MS;

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

  /** Imports a WSDL definition and stores the full `WsdlImportResult` under a new id. */
  async importDefinition(request: DefinitionImportRequest, hooks: EngineServiceHooks = {}): Promise<InterfaceSummary> {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    if (request.token !== undefined) {
      this.imports.set(request.token, controller);
    }
    const wireAuth = request.options?.auth;
    let auth: { readonly username: string; readonly password: string } | KerberosSendAuth | undefined;
    if (wireAuth !== undefined && 'type' in wireAuth) {
      auth = { type: 'kerberos', ...(wireAuth.spn !== undefined ? { spn: wireAuth.spn } : {}) };
    } else if (wireAuth !== undefined) {
      const password = await this.getSecret?.(wireAuth.passwordRef);
      if (password === undefined) {
        throw new WirebenchError('secret-missing', secretMissingMessage(wireAuth.username), {
          details: { ref: wireAuth.passwordRef },
        });
      }
      auth = { username: wireAuth.username, password };
    }
    let result: WsdlImportResult;
    try {
      result = await engineImportDefinition(toEngineSource(request.source), {
        ...(auth !== undefined ? { auth } : {}),
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
    auth?: { readonly username: string; readonly password: string } | KerberosSendAuth,
    signal?: AbortSignal,
  ): Promise<WsdlImportResult> {
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
      readonly auth?: { readonly username: string; readonly password: string } | KerberosSendAuth;
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
    let result: WsdlImportResult;
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
  commitResult(interfaceId: string, result: WsdlImportResult, definitionUrl: string): InterfaceSummary {
    const loadedAt = Date.now();
    this.definitions.set(interfaceId, { result, definitionUrl, loadedAt });
    return { ...toInterfaceSummary(result, interfaceId, definitionUrl), loadedAt };
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

  /** Frees the in-memory `WsdlImportResult` for `interfaceId`. */
  close(interfaceId: string): { closed: boolean } {
    return { closed: this.definitions.delete(interfaceId) };
  }

  /** The resolved `SchemaSet` for `interfaceId`, for completion/declaration lookups. Throws `unknown-interface` if absent. */
  schemaSetFor(interfaceId: string) {
    return this.lookup(interfaceId).schemaSet;
  }

  /** The whole in-memory `WsdlImportResult` for `interfaceId`. Throws `unknown-interface` if absent. */
  resultFor(interfaceId: string): WsdlImportResult {
    return this.lookup(interfaceId);
  }

  /** When `interfaceId`'s definition was last loaded into memory (epoch ms). Throws `unknown-interface` if absent. */
  loadedAtFor(interfaceId: string): number {
    return this.lookupStored(interfaceId).loadedAt;
  }

  private lookup(interfaceId: string): WsdlImportResult {
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
        ? generateEmptySoapRequest(result, opRef)
        : generateSoapRequest(result, opRef, toEngineGenerateOptions(request.options));
    return toGenerateResponse(generated);
  }

  /** Checks one response in the app's REST checker worker, starting it on first use. Never rejects. */
  checkRestContract(input: RestContractInput): Promise<RestContractResult> {
    this.restChecker ??= createRestContractChecker();
    return this.restChecker.check(input);
  }

  /** Ends the REST checker worker, if one is running; a check still waiting reports `not-checked`. */
  async disposeRestContractChecker(): Promise<void> {
    const checker = this.restChecker;
    this.restChecker = undefined;
    await checker?.dispose();
  }
}
