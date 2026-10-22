/**
 * Finds where a request's files live on disk, so a caller (the desktop main process, for a
 * `<slug>.golden.yaml` snapshot sidecar) can place a file beside them without re-deriving the
 * layout each protocol's storage owns. Each module answers for its own containers through its
 * storage facet's `requestLocation`, and for its project-level files (REST's webhook collection)
 * through its `projectFiles.requestLocation`.
 */

import type { Project } from './model.js';
import type { RequestFileLocation } from './request-tree.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocol/default-registry.js';

/**
 * Locates the request identified by `requestId`: the folder it lives under and its file slug.
 *
 * A module whose storage has no `requestLocation` (gRPC and WebSocket today) has none, and neither has
 * an unknown id: both return `undefined`. `dir` and `slug` are derived the same way each module
 * writes its files, so `${dir}/${slug}.request.yaml` is always a key of `projectFiles(project)`.
 */
export function requestFileLocation(
  project: Project,
  requestId: string,
  registry: ProtocolRegistry = defaultRegistry(),
): RequestFileLocation | undefined {
  for (const { storage } of registry.modules) {
    if (storage.requestLocation === undefined) continue;
    for (const container of storage.containers(project)) {
      const found = storage.requestLocation(container, requestId);
      if (found !== undefined) return found;
    }
  }
  // After every container, as the webhook collection was always looked in last.
  for (const { projectFiles: facet } of registry.modules) {
    const found = facet?.requestLocation?.(project, requestId);
    if (found !== undefined) return found;
  }
  return undefined;
}

export type { RequestFileLocation } from './request-tree.js';
