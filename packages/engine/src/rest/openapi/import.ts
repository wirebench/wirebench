/**
 * Reading an OpenAPI document from wherever the user pointed at, resolved and parsed.
 *
 * The mapping onto an API, its folders and its requests is a separate step (the import task), so
 * this module's job ends at "a document this client understands, plus every file it was made of".
 * Those files are what the definition cache stores, byte for byte, which is what lets the API tab
 * export exactly what was imported.
 */

import { OpenApiError } from '../../errors.js';
import type { FetchDocument } from '../../wsdl/resolver.js';
import type { OpenApiDocument } from './model.js';
import { parseOpenApiDocument } from './parse.js';
import { resolveRefs, type RefProblem, type ResolvedDocument } from './refs.js';

/** Where a document comes from: a location to fetch, or text the user already has. */
export type OpenApiSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string }
  /** Text with a location to resolve relative references against — a paste, or a test. */
  | { readonly kind: 'text'; readonly text: string; readonly location?: string };

export interface ParseOpenApiOptions {
  readonly fetchDocument: FetchDocument;
  readonly signal?: AbortSignal;
}

/** A parsed document and everything it was made of. */
export interface ParsedOpenApi {
  readonly document: OpenApiDocument;
  /** Every file fetched, root first — what the definition cache stores. */
  readonly documents: readonly ResolvedDocument[];
  /** References that could not be followed. The import continues without them. */
  readonly refProblems: readonly RefProblem[];
}

/** The absolute location a source resolves references against. */
function locationOf(source: OpenApiSource): string {
  if (source.kind === 'url') {
    return source.url;
  }
  if (source.kind === 'file') {
    // A path, not a URL: the caller owns turning it into one, because only it knows the platform's
    // rules. `pathToFileURL` lives in the host, so this is deliberately strict rather than clever.
    if (!source.path.startsWith('file:')) {
      throw new OpenApiError('openapi-source-invalid', 'A file source must be given as a file: URL', {
        details: { path: source.path },
      });
    }
    return source.path;
  }
  // Pasted text has no folder of its own, so `inline:` is its world — the reference policy then
  // refuses a local file reference out of it, which is the point.
  return source.location ?? 'inline:openapi';
}

/**
 * Fetches (when needed), resolves and parses one OpenAPI document.
 *
 * @throws OpenApiError `openapi-malformed`, `openapi-not-a-document`, `openapi-unsupported-version`
 * or `openapi-source-invalid`; an `AbortError` when the signal fires mid-fetch.
 */
export async function parseOpenApi(source: OpenApiSource, options: ParseOpenApiOptions): Promise<ParsedOpenApi> {
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
    // The post-redirect location: a document moved by a redirect references its siblings from
    // where it actually lives, not from where it was asked for.
    rootLocation = fetched.location;
  }

  const resolved = await resolveRefs(
    text,
    rootLocation,
    {
      fetchDocument: options.fetchDocument,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    bytes,
  );
  return {
    document: parseOpenApiDocument(resolved.document),
    documents: resolved.documents,
    refProblems: resolved.problems,
  };
}
