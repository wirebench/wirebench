/**
 * Pure Node service wrapping `@wirebench/engine`: holds imported definitions and in-flight
 * sends in memory, and translates between the engine's rich types and the JSON-serialisable
 * wire shapes the IPC layer sends across the context bridge. No `electron` import — the
 * `ipc/definition.ts`/`ipc/request.ts` handlers own the `ipcMain`/`webContents` plumbing.
 */

import {
  generateEmptyRequest,
  generateRequest,
  importDefinition as engineImportDefinition,
  sendSoapRequest,
  WirebenchError,
} from '@wirebench/engine';
import type {
  GenerateOptions,
  ImportProgress,
  ImportResult,
  ImportSource,
  QName,
  SoapSendInput,
  TlsOptions,
} from '@wirebench/engine';
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
} from '../shared/wire-types.js';
import { toExchangeSummary, toGenerateResponse, toInterfaceSummary } from './engine-wire.js';

/** One imported definition kept in memory, alongside the location it was resolved from. */
interface StoredDefinition {
  readonly result: ImportResult;
  readonly definitionUrl: string;
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

/** Converts the wire `SoapSendInputWire` (plus a controller's signal) to the engine's `SoapSendInput`. */
function toEngineSendInput(input: SoapSendInputWire, signal: AbortSignal): SoapSendInput {
  return {
    endpoint: input.endpoint,
    envelopeXml: input.envelopeXml,
    soapVersion: input.soapVersion,
    ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.followRedirects !== undefined ? { followRedirects: input.followRedirects } : {}),
    ...(input.maxSizeBytes !== undefined ? { maxSizeBytes: input.maxSizeBytes } : {}),
    ...(input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {}),
    ...(input.tls !== undefined ? { tls: toEngineTls(input.tls) } : {}),
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

  /** Imports a WSDL definition and stores the full `ImportResult` under a new id. */
  async importDefinition(request: DefinitionImportRequest, hooks: EngineServiceHooks = {}): Promise<InterfaceSummary> {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    if (request.token !== undefined) {
      this.imports.set(request.token, controller);
    }
    let result: ImportResult;
    try {
      result = await engineImportDefinition(toEngineSource(request.source), {
        ...(request.options?.auth !== undefined ? { auth: request.options.auth } : {}),
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
    this.definitions.set(id, { result, definitionUrl });
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
    this.definitions.set(input.interfaceId, { result, definitionUrl });
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

  /** Sends a SOAP request, registering an `AbortController` so a matching `cancel` can abort it. */
  async send(request: RequestSendRequest): Promise<ExchangeSummary> {
    const controller = new AbortController();
    this.sends.set(request.sendId, controller);
    try {
      const exchange = await sendSoapRequest(toEngineSendInput(request.input, controller.signal));
      return toExchangeSummary(exchange, request.sendId);
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
