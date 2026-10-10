/** Where the secret scanner looks in WebSocket's APIs, and how a move rewrites them. */
import type { ProtocolSecrets } from '../protocol/module.js';
import { keyed, keyedEntries, mapShared, mapTree, patch, SEP, tree, url } from '../secrets/scan/support.js';
import type { ScanTarget } from '../secrets/scan/support.js';
import type { Project } from '../project/model.js';
import { withWsApis, wsApisOf } from './model.js';
import type { WsRequestDef } from './model.js';

function* wsRequest(request: WsRequestDef, prefix: string): Generator<ScanTarget> {
  const path = `${prefix}${SEP}${request.name}`;
  if (request.url !== '') yield url('ws-url', request.id, path, request.url);
  yield* keyed('ws-query', request.id, path, 'query', 'query', request.query);
  yield* keyed('ws-header', request.id, path, 'header', 'header', request.headers);
  for (const message of request.messages) {
    if (message.format !== 'text' || message.content === '') continue;
    yield {
      location: { kind: 'ws-message', requestId: request.id, messageId: message.id },
      label: `${path}${SEP}message ${message.name}`,
      text: message.content,
      context: {},
    };
  }
}

function* scanTargets(project: Project): Generator<ScanTarget> {
  for (const api of wsApisOf(project)) {
    yield* keyed('ws-api-header', api.id, api.name, 'header', 'header', api.headers);
    yield* tree(api, api.name, wsRequest);
  }
}

/** WebSocket's headers, on an API and on each request, and each request's URL, query and text messages. */
export const wsSecrets: ProtocolSecrets = {
  scanTargets,
  applyMoves: (project, rw) => {
    const apis = wsApisOf(project);
    const next = mapShared(apis, (api) =>
      mapTree(
        patch(api, { headers: keyedEntries(rw, 'ws-api-header', { apiId: api.id }, api.headers) }),
        (request: WsRequestDef) =>
          patch(request, {
            url: rw.text({ kind: 'ws-url', requestId: request.id }, request.url),
            query: keyedEntries(rw, 'ws-query', { requestId: request.id }, request.query),
            headers: keyedEntries(rw, 'ws-header', { requestId: request.id }, request.headers),
            messages: mapShared(request.messages, (message) =>
              message.format !== 'text'
                ? message
                : patch(message, {
                    content: rw.text(
                      { kind: 'ws-message', requestId: request.id, messageId: message.id },
                      message.content,
                    ),
                  }),
            ),
          }),
      ),
    );
    return next === apis ? project : withWsApis(project, next);
  },
};
