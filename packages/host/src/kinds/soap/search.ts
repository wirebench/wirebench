/**
 * SOAP's share of `search.query` (spec §5.4): the documents its requests and its cached definitions add to the corpus.
 */
import type { SearchDocument } from '../../search.js';
import type { KindSearch } from '../kind-main.js';

export const soapSearch: KindSearch = {
  requests({ snapshot, scopes, projectId, projectName }) {
    const documents: SearchDocument[] = [];
    const interfaceName = (id: string): string =>
      snapshot.interfaces.find((candidate) => candidate.id === id)?.name ?? id;
    for (const request of snapshot.requests) {
      if (scopes.requestBodies) {
        documents.push({
          kind: 'request-body',
          protocol: 'soap',
          text: request.envelopeXml,
          projectId,
          projectName,
          requestId: request.id,
          requestName: request.name,
          interfaceId: request.interfaceId,
          interfaceName: interfaceName(request.interfaceId),
        });
      }
      if (scopes.headers && request.headers.length > 0) {
        documents.push({
          kind: 'request-header',
          protocol: 'soap',
          // One header per line, so a match's line number points at the header that matched.
          text: request.headers.map((header) => `${header.name}: ${header.value}`).join('\n'),
          projectId,
          projectName,
          requestId: request.id,
          requestName: request.name,
          interfaceId: request.interfaceId,
          interfaceName: interfaceName(request.interfaceId),
        });
      }
    }
    return documents;
  },

  definitions({ snapshot, scopes, projectId, projectName, engine }) {
    const documents: SearchDocument[] = [];
    if (scopes.definitions) {
      for (const summary of snapshot.interfaces) {
        let bundle;
        try {
          bundle = engine.resultFor(summary.id).bundle;
        } catch {
          continue;
        }
        for (const document of bundle.documents) {
          documents.push({
            kind: 'document',
            text: document.text,
            projectId,
            projectName,
            interfaceId: summary.id,
            interfaceName: summary.name,
            location: document.location,
          });
        }
      }
    }
    return documents;
  },
};
