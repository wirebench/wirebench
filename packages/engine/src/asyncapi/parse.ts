/**
 * Reading an AsyncAPI 2.x or 3.0 document into the version-neutral view.
 *
 * The fetch, the `$ref` resolution and the source shapes are the OpenAPI import's own, so the
 * documents it hands back are what the definition cache already knows how to store. Only two
 * things are fatal: text that is not a document, and a version this reader does not know.
 * Everything else that cannot be mapped becomes a note on the document.
 */

import { AsyncApiError, OpenApiError } from '../errors.js';
import type { OpenApiSource } from '../rest/openapi/import.js';
import { parseDocumentText } from '../rest/openapi/parse.js';
import { resolveRefs, type RefProblem, type ResolvedDocument } from '../rest/openapi/refs.js';
import type { FetchDocument } from '../wsdl/resolver.js';
import type { AsyncApiDocument } from './model.js';
import { normaliseAsyncApi2 } from './normalise-2.js';
import { normaliseAsyncApi3 } from './normalise-3.js';
import { isRecord } from './read.js';

export interface ParseAsyncApiOptions {
  readonly fetchDocument: FetchDocument;
  readonly signal?: AbortSignal;
}

/** A parsed document and everything it was made of. */
export interface ParsedAsyncApi {
  readonly document: AsyncApiDocument;
  /** Every file fetched, root first — what the definition cache stores. */
  readonly documents: readonly ResolvedDocument[];
  /** References that could not be followed. The import continues without them. */
  readonly problems: readonly RefProblem[];
}

function locationOf(source: OpenApiSource): string {
  if (source.kind === 'url') return source.url;
  if (source.kind === 'file') {
    if (!source.path.startsWith('file:')) {
      throw new AsyncApiError('asyncapi-malformed', 'A file source must be given as a file: URL', {
        details: { path: source.path },
      });
    }
    return source.path;
  }
  return source.location ?? 'inline:asyncapi';
}

/** Which normaliser a declared version goes to, or a refusal naming it. */
function majorOf(declared: string): '2' | '3' {
  if (/^2\.[0-6](?:\.\d+)?$/.test(declared)) return '2';
  if (/^3\.0(?:\.\d+)?$/.test(declared)) return '3';
  throw new AsyncApiError(
    'asyncapi-version-unsupported',
    `AsyncAPI ${declared} is not supported; 2.0 to 2.6 and 3.0 are`,
    {
      details: { version: declared },
    },
  );
}

function parseRoot(text: string, where: string): unknown {
  try {
    return parseDocumentText(text, where);
  } catch (error) {
    if (error instanceof OpenApiError) {
      throw new AsyncApiError('asyncapi-malformed', error.message, { cause: error });
    }
    throw error;
  }
}

/**
 * Fetches (when needed), resolves and normalises one AsyncAPI document.
 *
 * @throws AsyncApiError `asyncapi-malformed` or `asyncapi-version-unsupported`; an `AbortError`
 * when the signal fires mid-fetch.
 */
export async function parseAsyncApi(source: OpenApiSource, options: ParseAsyncApiOptions): Promise<ParsedAsyncApi> {
  const location = locationOf(source);
  let text: string;
  let bytes: Uint8Array | undefined;
  let rootLocation = location;
  if (source.kind === 'text') {
    text = source.text;
  } else {
    const fetched = await options.fetchDocument(location, options.signal);
    text = fetched.text;
    bytes = fetched.bytes;
    rootLocation = fetched.location;
  }

  const raw = parseRoot(text, rootLocation);
  if (!isRecord(raw)) {
    throw new AsyncApiError('asyncapi-malformed', `${rootLocation} is not an AsyncAPI document`);
  }
  const declared = raw['asyncapi'];
  if (typeof declared !== 'string') {
    throw new AsyncApiError('asyncapi-malformed', `${rootLocation} has no asyncapi version`);
  }
  const major = majorOf(declared);

  const resolved = await resolveRefs(
    text,
    rootLocation,
    { fetchDocument: options.fetchDocument, ...(options.signal !== undefined ? { signal: options.signal } : {}) },
    bytes,
  );
  const document = isRecord(resolved.document) ? resolved.document : {};
  return {
    document: major === '2' ? normaliseAsyncApi2(raw, document, declared) : normaliseAsyncApi3(raw, document, declared),
    documents: resolved.documents,
    problems: resolved.problems,
  };
}
