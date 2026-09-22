/**
 * Running an OpenAPI import in main, with progress and a cancel.
 *
 * The engine's `importOpenApi` is one `await` with no notion of a window or a user: this is the
 * host's half of it — the fetcher that actually reaches the network, the progress events the import
 * dialog draws, and the abort controller `api.cancelImport` fires. Nothing is written to disk here;
 * placing the API and caching its documents is the project's job (`project-host.ts`), which is what
 * makes a cancelled import trivially leave nothing behind.
 */

import { createDefaultFetchDocument, importAsyncApi, importOpenApi, WirebenchError } from '@wirebench/engine';
import type { FetchDocument, ImportedAsyncApi, ImportedOpenApi, OpenApiSource } from '@wirebench/engine';
import type { EngineProgressEvent } from '../shared/wire-types.js';

/** What one import needs beyond where to read from. */
export interface RunOpenApiImportInput {
  readonly source: OpenApiSource;
  /** Echoed on every progress event, and what `cancel` names this import by. */
  readonly token?: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly securityScheme?: string;
  readonly includeOptional?: boolean;
  readonly sampleValues?: boolean;
}

/** What one AsyncAPI import needs: the same source and token, and which server to dial. */
export interface RunAsyncApiImportInput {
  readonly source: OpenApiSource;
  readonly token?: string;
  /** The `ws`/`wss` server, by its key in the document; absent picks the first one. */
  readonly server?: string;
}

/** Hooks one import reports through. */
export interface RunOpenApiImportHooks {
  readonly onProgress?: (event: EngineProgressEvent) => void;
}

/**
 * Owns the in-flight OpenAPI imports of the session.
 *
 * One controller per token, dropped as soon as the import settles, so a `cancel` for an import that
 * has already finished is a no-op rather than an error — the dialog may well send one on the way out.
 */
export class OpenApiImportService {
  private readonly fetchDocument: FetchDocument;
  private readonly inFlight = new Map<string, AbortController>();

  constructor(options?: { readonly fetchDocument?: FetchDocument }) {
    this.fetchDocument = options?.fetchDocument ?? createDefaultFetchDocument();
  }

  /**
   * Fetches, resolves, parses and maps one document.
   *
   * @throws the engine's `OpenApiError` codes, or an `AbortError` when the import was cancelled
   */
  async run(input: RunOpenApiImportInput, hooks: RunOpenApiImportHooks = {}): Promise<ImportedOpenApi> {
    return this.track(input.token, hooks, async (fetchDocument, signal, progress) => {
      const imported = await importOpenApi(input.source, {
        fetchDocument,
        signal,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.securityScheme !== undefined ? { securityScheme: input.securityScheme } : {}),
        ...(input.includeOptional !== undefined ? { includeOptional: input.includeOptional } : {}),
        ...(input.sampleValues !== undefined ? { sampleValues: input.sampleValues } : {}),
      });
      progress('done', `Imported ${String(imported.summary.requests)} requests`);
      return imported;
    });
  }

  /**
   * Fetches, resolves, parses and maps one AsyncAPI document into a WebSocket API. It shares the
   * token map with {@link run}, so `api.cancelImport` stops it the same way.
   *
   * @throws the engine's `AsyncApiError` codes, or an `AbortError` when the import was cancelled
   */
  async runAsyncApi(input: RunAsyncApiImportInput, hooks: RunOpenApiImportHooks = {}): Promise<ImportedAsyncApi> {
    return this.track(input.token, hooks, async (fetchDocument, signal, progress) => {
      const imported = await importAsyncApi(input.source, {
        fetchDocument,
        signal,
        ...(input.server !== undefined ? { server: input.server } : {}),
      });
      progress('done', `Imported ${String(imported.summary.requests)} requests`);
      return imported;
    });
  }

  /** Runs one import under `token`'s controller, naming every document fetched as progress. */
  private async track<T>(
    token: string | undefined,
    hooks: RunOpenApiImportHooks,
    body: (
      fetchDocument: FetchDocument,
      signal: AbortSignal,
      progress: (phase: EngineProgressEvent['phase'], message: string) => void,
    ) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    if (token !== undefined) {
      // A second import under the same token replaces the first: the dialog only ever has one.
      this.inFlight.get(token)?.abort();
      this.inFlight.set(token, controller);
    }

    const progress = (phase: EngineProgressEvent['phase'], message: string): void => {
      hooks.onProgress?.({ kind: 'import', phase, message, ...(token !== undefined ? { token } : {}) });
    };

    let fetched = 0;
    const fetchDocument: FetchDocument = async (location, signal) => {
      fetched += 1;
      // Every document the resolver reaches is named, because a reference to a slow host is exactly
      // the case where the user needs to know what the import is waiting for.
      progress('fetch', fetched === 1 ? `Fetching ${location}` : `Fetching ${location} (${String(fetched)})`);
      return this.fetchDocument(location, signal);
    };

    try {
      progress('fetch', 'Starting');
      return await body(fetchDocument, controller.signal, progress);
    } catch (error) {
      // A cancel is named as one over IPC; otherwise the envelope would call it an internal error.
      if (controller.signal.aborted) {
        throw new WirebenchError('aborted', 'The import was cancelled');
      }
      throw error;
    } finally {
      if (token !== undefined && this.inFlight.get(token) === controller) {
        this.inFlight.delete(token);
      }
    }
  }

  /** Aborts the import running under `token`, if one still is. */
  cancel(token: string): { readonly cancelled: boolean } {
    const controller = this.inFlight.get(token);
    if (controller === undefined) {
      return { cancelled: false };
    }
    controller.abort();
    this.inFlight.delete(token);
    return { cancelled: true };
  }

  /** Aborts every in-flight import; called when the window goes away. */
  cancelAll(): void {
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }
}
