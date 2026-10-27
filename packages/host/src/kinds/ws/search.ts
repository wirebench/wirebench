/**
 * WebSocket's share of `search.query` (spec §5.4): the documents its requests add to the corpus.
 */
import type { SearchDocument } from '../../search.js';
import type { KindSearch } from '../kind-main.js';

export const wsSearch: KindSearch = {
  requests({ snapshot, scopes, projectId, projectName }) {
    const documents: SearchDocument[] = [];
    // A WebSocket request's searchable text is its URL, its subprotocols and its saved messages —
    // the header table is a separate document, as for the other two protocols. A binary message's
    // content is base64, not text: indexing it would put opaque bytes in the corpus and produce
    // garbage substring hits, so — mirroring how the REST indexer above only indexes a `raw`/`form`
    // body and skips `binary`/`multipart` — only a message's name is indexed for a binary message;
    // its content joins the corpus only when the message is text.
    for (const request of snapshot.wsRequests) {
      const apiName = snapshot.wsApis.find((api) => api.id === request.apiId)?.name ?? request.apiId;
      if (scopes.requestBodies) {
        const lines = [request.name, request.url];
        if (request.subprotocols.length > 0) {
          lines.push(request.subprotocols.join(', '));
        }
        for (const message of request.messages) {
          lines.push(message.format === 'text' ? `${message.name}: ${message.content}` : message.name);
        }
        documents.push({
          kind: 'request-body',
          protocol: 'websocket',
          text: lines.join('\n'),
          projectId,
          projectName,
          requestId: request.id,
          requestName: request.name,
          interfaceId: request.apiId,
          interfaceName: apiName,
        });
      }
      if (scopes.headers && request.headers.length > 0) {
        documents.push({
          kind: 'request-header',
          protocol: 'websocket',
          text: request.headers.map((header) => `${header.name}: ${header.value}`).join('\n'),
          projectId,
          projectName,
          requestId: request.id,
          requestName: request.name,
          interfaceId: request.apiId,
          interfaceName: apiName,
        });
      }
    }
    return documents;
  },
};
