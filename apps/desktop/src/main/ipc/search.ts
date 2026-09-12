import { channels } from '../../shared/ipc.js';
import type { SearchQueryRequest } from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import type { ProjectHost } from '../project-host.js';
import { searchDocuments } from '../search.js';
import type { SearchDocument } from '../search.js';
import { registerHandler } from './register.js';

/** The `ProjectHost` surface `search.query` needs; a stub stands in for it in tests. */
export type SearchChannelProject = Pick<ProjectHost, 'snapshot'>;

/**
 * Where the corpus comes from: every host the open workspace holds. Search spans all projects
 * (spec §3.4), so the channel is given the router rather than one project —
 * `WorkspaceService.hosts()` satisfies this structurally.
 */
export interface SearchChannelProjects {
  hosts(): readonly SearchChannelProject[];
}

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
  projects: SearchChannelProjects,
  engine: SearchChannelEngine,
  scopes: SearchQueryRequest['scopes'],
): readonly SearchDocument[] {
  const documents: SearchDocument[] = [];
  for (const host of projects.hosts()) {
    collectFrom(host, engine, scopes, documents);
  }
  return documents;
}

/** Appends one project's documents to `documents`, each tagged with the project it came from. */
function collectFrom(
  project: SearchChannelProject,
  engine: SearchChannelEngine,
  scopes: SearchQueryRequest['scopes'],
  documents: SearchDocument[],
): void {
  const snapshot = project.snapshot();
  if (snapshot === null) {
    return;
  }
  const interfaceName = (id: string): string =>
    snapshot.interfaces.find((candidate) => candidate.id === id)?.name ?? id;
  const projectId = snapshot.id;
  const projectName = snapshot.name;

  for (const request of snapshot.requests) {
    if (scopes.requestBodies) {
      documents.push({
        kind: 'request-body',
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
}

/** Registers `search.query`: workspace-wide find over requests, headers and cached definitions. */
export function registerSearchChannels(engine: SearchChannelEngine, projects: SearchChannelProjects): void {
  registerHandler(channels.search.query, (request) =>
    Promise.resolve(searchDocuments(searchCorpus(projects, engine, request.scopes), request)),
  );
}
