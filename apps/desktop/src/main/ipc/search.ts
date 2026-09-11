import { channels } from '../../shared/ipc.js';
import type { SearchQueryRequest } from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import type { ProjectHost } from '../project-host.js';
import { searchDocuments } from '../search.js';
import type { SearchDocument } from '../search.js';
import { registerHandler } from './register.js';

/** The `ProjectHost` surface `search.query` needs; a stub stands in for it in tests. */
export type SearchChannelProject = Pick<ProjectHost, 'snapshot'>;

/** The `EngineService` surface `search.query` needs. */
export type SearchChannelEngine = Pick<EngineService, 'resultFor'>;

/**
 * The corpus one query looks at: request envelopes, request headers, and the cached definition
 * documents — each only when its scope is on.
 *
 * A definition that is not loaded into memory (an interface whose hydration failed, or one
 * closed since) is skipped rather than failing the whole search: a partial project is exactly
 * when a user reaches for find.
 */
export function searchCorpus(
  project: SearchChannelProject,
  engine: SearchChannelEngine,
  scopes: SearchQueryRequest['scopes'],
): readonly SearchDocument[] {
  const snapshot = project.snapshot();
  if (snapshot === null) {
    return [];
  }
  const interfaceName = (id: string): string =>
    snapshot.interfaces.find((candidate) => candidate.id === id)?.name ?? id;
  const documents: SearchDocument[] = [];

  for (const request of snapshot.requests) {
    if (scopes.requestBodies) {
      documents.push({
        kind: 'request-body',
        text: request.envelopeXml,
        requestId: request.id,
        requestName: request.name,
        interfaceId: request.interfaceId,
        interfaceName: interfaceName(request.interfaceId),
      });
    }
    if (scopes.headers && request.headers.length > 0) {
      documents.push({
        kind: 'request-header',
        // One header per line, so a match's line number points at the header that matched.
        text: request.headers.map((header) => `${header.name}: ${header.value}`).join('\n'),
        requestId: request.id,
        requestName: request.name,
        interfaceId: request.interfaceId,
        interfaceName: interfaceName(request.interfaceId),
      });
    }
  }

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
          interfaceId: summary.id,
          interfaceName: summary.name,
          location: document.location,
        });
      }
    }
  }

  return documents;
}

/** Registers `search.query`: project-wide find over requests, headers and cached definitions. */
export function registerSearchChannels(engine: SearchChannelEngine, project: SearchChannelProject): void {
  registerHandler(channels.search.query, (request) =>
    Promise.resolve(searchDocuments(searchCorpus(project, engine, request.scopes), request)),
  );
}
