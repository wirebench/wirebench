/**
 * A REST mock serving its OpenAPI document (spec §Serving the OpenAPI document): `GET <mock>/openapi.json`
 * and `/openapi.yaml` are the cached root document, `/openapi/<n>.json` and `/openapi/<n>.yaml` the cache's
 * other documents by index. In each, the server URL points at the mock and every `$ref` that resolves to a
 * cached document points at its URL under the mock, so a client that reads the contract from the mock gets
 * the whole of it from the mock.
 *
 * Only cached documents can be served, by index: a request cannot name a path or a URL. No document's
 * location is ever written into a reply (a location may carry a credential in its query), and a `$ref`
 * that resolves to nothing in the cache is left as the document wrote it.
 */

import { stringify as stringifyYamlDocument } from 'yaml';
import { parseDocumentText } from '../json/schema/parse-text.js';
import type { ResolvedDocument } from '../json/schema/refs.js';
import type { MockReply } from '../mock/contract.js';

type Format = 'json' | 'yaml';

/** Nesting deeper than this is refused rather than walked (a document is never this deep). */
const MAX_DEPTH = 2000;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** The document and format a mock-relative path asks for, or undefined when it asks for none. */
export function askedDocument(path: string): { readonly index: number; readonly format: Format } | undefined {
  const root = /^\/openapi\.(json|yaml)$/.exec(path);
  if (root !== null) return { index: 0, format: root[1] as Format };
  const other = /^\/openapi\/(\d{1,4})\.(json|yaml)$/.exec(path);
  if (other !== null) return { index: Number(other[1]), format: other[2] as Format };
  return undefined;
}

function servedAt(index: number, format: Format, base: string): string {
  return index === 0 ? `${base}/openapi.${format}` : `${base}/openapi/${String(index)}.${format}`;
}

function indexOf(documents: readonly ResolvedDocument[], reference: string, location: string): number | undefined {
  let resolved: string;
  try {
    resolved = new URL(reference, location).href;
  } catch {
    return undefined;
  }
  const index = documents.findIndex(
    (document) => document.location === resolved || document.requestedLocation === resolved,
  );
  return index === -1 ? undefined : index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A copy of `value` with every `$ref` passed through `rewriteRef`. */
function rewriteRefs(value: unknown, rewriteRef: (ref: string) => string): unknown {
  const onPath = new Set<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node !== 'object' || node === null) return node;
    if (depth > MAX_DEPTH || onPath.has(node)) throw new Error('it is too deep or contains itself');
    onPath.add(node);
    try {
      if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) {
        out[key] = key === '$ref' && typeof item === 'string' ? rewriteRef(item) : walk(item, depth + 1);
      }
      return out;
    } finally {
      onPath.delete(node);
    }
  };
  return walk(value, 0);
}

/** Points the document's servers at the mock: OpenAPI 3 `servers` at every level, Swagger 2 `host`. */
function rewriteServers(document: Record<string, unknown>, base: string): void {
  if (typeof document['swagger'] === 'string') {
    const url = new URL(`${base}/`);
    document['host'] = url.host;
    document['basePath'] = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
    document['schemes'] = [url.protocol.replace(/:$/, '')];
    return;
  }
  const servers = [{ url: base }];
  if (typeof document['openapi'] === 'string') document['servers'] = servers;
  const paths = document['paths'];
  if (!isRecord(paths)) return;
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue;
    if ('servers' in item) item['servers'] = servers;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (isRecord(operation) && 'servers' in operation) operation['servers'] = servers;
    }
  }
}

function plain(status: number, text: string): MockReply {
  return { status, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: `${text}\n` };
}

/**
 * Document `index` of the cache (root first) as `format`, rewritten for the mock at `mockUrl`; a 404
 * when the cache has no such document.
 */
export function openApiReply(
  documents: readonly ResolvedDocument[],
  index: number,
  format: Format,
  mockUrl: string,
): MockReply {
  const document = documents[index];
  if (document === undefined) return plain(404, `No document ${String(index)}`);
  const base = mockUrl.replace(/\/+$/, '');
  let body: string;
  try {
    const rewritten = rewriteRefs(parseDocumentText(document.text), (ref) => {
      const hash = ref.indexOf('#');
      const target = hash === -1 ? ref : ref.slice(0, hash);
      if (target === '') return ref;
      const found = indexOf(documents, target, document.location);
      return found === undefined ? ref : `${servedAt(found, format, base)}${hash === -1 ? '' : ref.slice(hash)}`;
    });
    if (index === 0 && isRecord(rewritten)) rewriteServers(rewritten, base);
    body =
      format === 'json'
        ? `${JSON.stringify(rewritten, null, 2)}\n`
        : stringifyYamlDocument(rewritten, { lineWidth: 0, aliasDuplicateObjects: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return plain(500, `The cached document ${String(index)} cannot be served: ${reason}`);
  }
  return {
    status: 200,
    headers: [['Content-Type', format === 'json' ? 'application/json' : 'application/yaml']],
    body,
  };
}
