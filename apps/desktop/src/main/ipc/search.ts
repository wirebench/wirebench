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

  // A REST request's searchable text is its URL, its tables and its body — the three places a
  // user looks for "which request talks to /orders". The API's name takes the interface name's slot
  // so a match reads the same way in the results list whichever protocol it came from.
  for (const request of snapshot.restRequests) {
    const apiName = snapshot.apis.find((api) => api.id === request.apiId)?.name ?? request.apiId;
    if (scopes.requestBodies) {
      const body = request.body;
      const lines = [`${request.method} ${request.url}`];
      for (const row of [...request.pathParams, ...request.query]) {
        lines.push(`${row.name}=${row.value}`);
      }
      if (body.kind === 'raw') {
        lines.push(body.text);
      } else if (body.kind === 'form') {
        for (const field of body.fields) {
          lines.push(`${field.name}=${field.value}`);
        }
      }
      documents.push({
        kind: 'request-body',
        protocol: 'rest',
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
        protocol: 'rest',
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
