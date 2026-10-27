/**
 * gRPC's share of `search.query` (spec §5.4): the documents its requests add to the corpus.
 */
import type { SearchDocument } from '../../search.js';
import type { KindSearch } from '../kind-main.js';

export const grpcSearch: KindSearch = {
  requests({ snapshot, scopes, projectId, projectName }) {
    const documents: SearchDocument[] = [];
    // A gRPC request's searchable text is its method, its message and its metadata — the API's name
    // in the interface's slot, as for REST.
    for (const request of snapshot.grpcRequests) {
      const apiName = snapshot.grpcApis.find((api) => api.id === request.apiId)?.name ?? request.apiId;
      if (scopes.requestBodies) {
        documents.push({
          kind: 'request-body',
          protocol: 'grpc',
          text: [`${request.service}/${request.method}`, request.message].join('\n'),
          projectId,
          projectName,
          requestId: request.id,
          requestName: request.name,
          interfaceId: request.apiId,
          interfaceName: apiName,
        });
      }
      if (scopes.headers && request.metadata.length > 0) {
        documents.push({
          kind: 'request-header',
          protocol: 'grpc',
          text: request.metadata.map((row) => `${row.name}: ${row.value}`).join('\n'),
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
