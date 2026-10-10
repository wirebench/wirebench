/**
 * Finds where a request's files live on disk, so a caller (the desktop main process, for a
 * `<slug>.golden.yaml` snapshot sidecar) can place a file beside them without re-deriving the
 * layout each protocol's storage owns. Each module answers for its own containers through its
 * storage facet's `requestLocation`.
 */

import type { Project } from './model.js';
import { locateInTree } from './request-tree.js';
import type { RequestFileLocation } from './request-tree.js';
import { REQUESTS_DIR, WEBHOOKS_DIR } from './paths.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';

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
  for (const module of registry.modules) {
    const { storage } = module;
    if (storage.requestLocation === undefined) continue;
    for (const container of storage.containers(project)) {
      const found = storage.requestLocation(container, requestId);
      if (found !== undefined) return found;
    }
  }
  if (project.webhooks !== undefined) {
    return locateInTree(project.webhooks, `${WEBHOOKS_DIR}/${REQUESTS_DIR}`, requestId);
  }
  return undefined;
}

export type { RequestFileLocation } from './request-tree.js';
