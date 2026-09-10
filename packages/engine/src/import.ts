/**
 * Imports a WSDL definition end to end: resolve its import graph, parse the
 * merged WSDL, compile the schema set, and summarize the operations a user
 * can pick from.
 */

import { pathToFileURL } from 'node:url';
import { HttpError, WsdlParseError } from './errors.js';
import { summarizeOperations } from './operations.js';
import type { ImportOptions, ImportProblem, ImportResult, ImportSource } from './types.js';
import { createDefaultFetchDocument } from './wsdl/fetch.js';
import { parseWsdlBundle } from './wsdl/merge.js';
import type { DefinitionSource, FetchDocument } from './wsdl/resolver.js';
import { resolveDefinition } from './wsdl/resolver.js';
import { buildSchemaSet } from './xsd/schema-set.js';

/** Turns an {@link ImportSource} into the `DefinitionSource` the resolver understands. */
function toDefinitionSource(source: ImportSource): DefinitionSource {
  if (source.kind === 'file') {
    return { location: pathToFileURL(source.path).href };
  }
  if (source.kind === 'text') {
    return { location: source.location ?? 'inline:wsdl', text: source.text };
  }
  try {
    return { location: new URL(source.url).toString() };
  } catch (cause) {
    throw new WsdlParseError('invalid-url', `"${source.url}" is not a valid URL`, {
      cause,
      details: { url: source.url },
    });
  }
}

/** Wraps `fetchDocument` to add HTTP Basic auth to every `http(s)://` fetch. */
function withBasicAuth(fetchDocument: FetchDocument, auth: { username: string; password: string }): FetchDocument {
  const header = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  return async (location, signal) => {
    if (!location.startsWith('http:') && !location.startsWith('https:')) {
      return fetchDocument(location, signal);
    }
    const response = await fetch(location, {
      redirect: 'follow',
      ...(signal !== undefined ? { signal } : {}),
      headers: { authorization: header, 'user-agent': 'wirebench/0.1' },
    });
    if (!response.ok) {
      throw new HttpError('fetch-failed', `GET ${location} failed with status ${response.status}`, {
        details: { location, status: response.status },
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { location: response.url, bytes, text: new TextDecoder('utf-8').decode(bytes) };
  };
}

/**
 * Imports a WSDL definition from a URL, file path, or inline text: resolves
 * its full import graph, parses the merged WSDL, compiles the schema set,
 * and summarizes its operations for a picker UI.
 *
 * Never throws for a modelling problem in the definition itself — those are
 * reported in {@link ImportResult.problems}. It does throw for a malformed
 * `ImportSource` (an invalid URL) or when the root document cannot be
 * fetched at all.
 *
 * @param source where the WSDL comes from
 * @param options fetch override, Basic auth for fetching, abort signal, progress callback
 */
export async function importDefinition(source: ImportSource, options?: ImportOptions): Promise<ImportResult> {
  const signal = options?.signal;
  const baseFetch = options?.fetchDocument ?? createDefaultFetchDocument();
  const fetchDocument = options?.auth !== undefined ? withBasicAuth(baseFetch, options.auth) : baseFetch;
  const definitionSource = toDefinitionSource(source);

  options?.onProgress?.({ phase: 'fetch', location: definitionSource.location });
  const bundle = await resolveDefinition(definitionSource, {
    fetchDocument,
    ...(signal !== undefined ? { signal } : {}),
  });

  options?.onProgress?.({ phase: 'parse' });
  const definition = parseWsdlBundle(bundle);

  options?.onProgress?.({ phase: 'schema' });
  const schemaSet = buildSchemaSet(bundle);

  const problems: ImportProblem[] = [
    ...bundle.problems.map((p): ImportProblem => ({ source: 'resolve', ...p })),
    ...definition.problems.map((p): ImportProblem => ({ source: 'wsdl', ...p })),
    ...schemaSet.problems.map((p): ImportProblem => ({ source: 'schema', ...p })),
  ];

  const operations = summarizeOperations(definition);

  options?.onProgress?.({ phase: 'done' });

  return { definition, bundle, schemaSet, problems, operations };
}
