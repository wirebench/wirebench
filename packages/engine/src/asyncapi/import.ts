/**
 * Import = parse + map, with the fetched documents handed back for the definition cache and the
 * references that could not be followed added to the summary.
 */

import type { OpenApiSource } from '../rest/openapi/import.js';
import type { ResolvedDocument } from '../rest/openapi/refs.js';
import { mapAsyncApi, type MapAsyncApiOptions, type MappedAsyncApi } from './map.js';
import type { AsyncApiDocument } from './model.js';
import { parseAsyncApi, type ParseAsyncApiOptions } from './parse.js';

export interface ImportAsyncApiOptions extends ParseAsyncApiOptions, MapAsyncApiOptions {}

export interface ImportedAsyncApi extends MappedAsyncApi {
  /** Every file fetched, root first — what the definition cache stores. */
  readonly documents: readonly ResolvedDocument[];
  readonly declaredVersion: string;
  /** The parsed document, for a caller that wants to map again with another server. */
  readonly document: AsyncApiDocument;
}

function sourceOf(source: OpenApiSource): string {
  if (source.kind === 'url') return source.url;
  if (source.kind === 'file') return source.path;
  return source.location ?? 'inline:asyncapi';
}

/**
 * Fetches, resolves, parses and maps one AsyncAPI document into a WebSocket API.
 *
 * @throws AsyncApiError the codes `parseAsyncApi` and `mapAsyncApi` throw; an `AbortError` when the
 * signal fires
 */
export async function importAsyncApi(source: OpenApiSource, options: ImportAsyncApiOptions): Promise<ImportedAsyncApi> {
  const parsed = await parseAsyncApi(source, options);
  const mapped = mapAsyncApi(parsed.document, options);
  const skipped = [
    ...mapped.summary.skipped,
    ...parsed.problems.map((problem) => ({ where: problem.at, reason: `${problem.ref}: ${problem.reason}` })),
  ];
  return {
    api: { ...mapped.api, definition: { kind: 'asyncapi', source: sourceOf(source), cache: true } },
    summary: { ...mapped.summary, skipped },
    documents: parsed.documents,
    declaredVersion: parsed.document.declaredVersion,
    document: parsed.document,
  };
}
