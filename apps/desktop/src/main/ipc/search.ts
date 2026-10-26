import { channels } from '../../shared/ipc.js';
import type { SearchQueryRequest } from '../../shared/wire-base.js';
import type { EngineService } from '../engine-service.js';
import type { ProjectHost } from '../project-host.js';
import { searchDocuments } from '../search.js';
import type { SearchDocument } from '../search.js';
import { MAIN_KINDS } from '../kinds/kind-main.js';
import { registerHandler, type HandlerTable } from './register.js';

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
  const context = { snapshot, scopes, projectId: snapshot.id, projectName: snapshot.name, engine };
  // Every kind's requests first, then every kind's cached definitions, as the corpus always ran.
  for (const kind of MAIN_KINDS) {
    documents.push(...(kind.search?.requests(context) ?? []));
  }
  for (const kind of MAIN_KINDS) {
    documents.push(...(kind.search?.definitions?.(context) ?? []));
  }
}

/** Registers `search.query`: workspace-wide find over requests, headers and cached definitions. */
export function registerSearchChannels(
  table: HandlerTable,
  engine: SearchChannelEngine,
  projects: SearchChannelProjects,
): void {
  registerHandler(table, channels.search.query, (request) =>
    Promise.resolve(searchDocuments(searchCorpus(projects, engine, request.scopes), request)),
  );
}
