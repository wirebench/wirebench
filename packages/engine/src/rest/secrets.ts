/**
 * Where the secret scanner looks in REST's APIs and the project's webhook collection (REST requests
 * in a tree of their own), and how a move rewrites them.
 */
import type { KeyValueEntry } from '../http/entries.js';
import type { Project } from '../project/model.js';
import type { ProtocolSecrets } from '../protocol/module.js';
import { keyed, keyedEntries, mapShared, mapTree, patch, SEP, tree, url } from '../secrets/scan/support.js';
import type { ScanTarget, SecretRewriter } from '../secrets/scan/support.js';
import { restApisOf, withRestApis } from './model.js';
import type { RestBody, RestRequestDef } from './model.js';

function rawContentType(body: Extract<RestBody, { kind: 'raw' }>): string {
  if (body.contentType !== undefined) return body.contentType;
  if (body.language === 'json') return 'application/json';
  if (body.language === 'xml') return 'application/xml';
  return 'text/plain';
}

function* bodyTargets(request: RestRequestDef, path: string): Generator<ScanTarget> {
  const { body } = request;
  if (body.kind === 'raw') {
    if (body.text !== '') {
      yield {
        location: { kind: 'rest-body', requestId: request.id },
        label: `${path}${SEP}body`,
        text: body.text,
        context: { contentType: rawContentType(body) },
      };
    }
    return;
  }
  const fields: readonly (KeyValueEntry | { readonly kind: 'file' })[] =
    body.kind === 'form' ? body.fields : body.kind === 'multipart' ? body.parts : [];
  for (let field = 0; field < fields.length; field++) {
    const entry = fields[field]!;
    if (!('value' in entry) || entry.value === '') continue;
    yield {
      location: { kind: 'rest-body', requestId: request.id, field, name: entry.name },
      label: `${path}${SEP}body field ${entry.name}`,
      text: entry.value,
      context: { fieldName: entry.name, nameKind: 'field' },
    };
  }
}

function* requestTargets(request: RestRequestDef, prefix: string): Generator<ScanTarget> {
  const path = `${prefix}${SEP}${request.name}`;
  if (request.url !== '') yield url('rest-url', request.id, path, request.url);
  yield* keyed('rest-query', request.id, path, 'query', 'query', request.query);
  yield* keyed('rest-header', request.id, path, 'header', 'header', request.headers);
  yield* bodyTargets(request, path);
}

function* scanTargets(project: Project): Generator<ScanTarget> {
  for (const api of restApisOf(project)) yield* tree(api, api.name, requestTargets);
  if (project.webhooks !== undefined) yield* tree(project.webhooks, 'Webhooks', requestTargets);
}

function rewriteBody(rw: SecretRewriter, requestId: string, body: RestBody): RestBody {
  if (body.kind === 'raw') {
    return patch(body, { text: rw.text({ kind: 'rest-body', requestId }, body.text) });
  }
  // Built in the key order the scan uses: the location's JSON is the rewriter's key.
  const field = <E extends KeyValueEntry | { readonly kind: 'file' }>(entry: E, index: number): E =>
    'value' in entry
      ? (patch<KeyValueEntry>(entry, {
          value: rw.text({ kind: 'rest-body', requestId, field: index, name: entry.name }, entry.value),
        }) as E)
      : entry;
  if (body.kind === 'form') return patch(body, { fields: mapShared(body.fields, field) });
  if (body.kind === 'multipart') return patch(body, { parts: mapShared(body.parts, field) });
  return body;
}

function rewriteRequest(rw: SecretRewriter, request: RestRequestDef): RestRequestDef {
  const requestId = request.id;
  return patch(request, {
    url: rw.text({ kind: 'rest-url', requestId }, request.url),
    query: keyedEntries(rw, 'rest-query', { requestId }, request.query),
    headers: keyedEntries(rw, 'rest-header', { requestId }, request.headers),
    body: rewriteBody(rw, requestId, request.body),
  });
}

/** REST's URLs, query tables, headers and bodies, in its APIs and in the webhook collection. */
export const restSecrets: ProtocolSecrets = {
  scanTargets,
  applyMoves: (project, rw) => {
    const apis = restApisOf(project);
    const nextApis = mapShared(apis, (api) => mapTree(api, (request: RestRequestDef) => rewriteRequest(rw, request)));
    const withApis = nextApis === apis ? project : withRestApis(project, nextApis);
    if (project.webhooks === undefined) return withApis;
    return patch(withApis, {
      webhooks: mapTree(project.webhooks, (request: RestRequestDef) => rewriteRequest(rw, request)),
    });
  },
};
