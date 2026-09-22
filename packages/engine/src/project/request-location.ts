/**
 * Finds where a request's files live on disk, so a caller (the desktop main process, for a
 * `<slug>.golden.yaml` snapshot sidecar) can place a file beside them without re-deriving the
 * layout `serialize.ts` already owns.
 */

import type { Project } from './model.js';
import type { RestFolder } from '../rest/model.js';
import { APIS_DIR, INTERFACES_DIR, OPERATIONS_DIR, REQUESTS_DIR } from './paths.js';

/** Where a request's files live: `dir` and `slug` such that `${dir}/${slug}.request.yaml` is a project file. */
export interface RequestFileLocation {
  /** POSIX path, relative to the project root. */
  readonly dir: string;
  readonly slug: string;
}

/** Depth-first search of a REST API's folder tree for the request with `requestId`. */
function findInFolders(
  folders: readonly RestFolder[],
  dir: string,
  requestId: string,
): RequestFileLocation | undefined {
  for (const folder of folders) {
    const childDir = `${dir}/${folder.slug}`;
    for (const request of folder.requests) {
      if (request.id === requestId) {
        return { dir: childDir, slug: request.slug };
      }
    }
    const found = findInFolders(folder.folders, childDir, requestId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Locates the request identified by `requestId`: the folder it lives under and its file slug.
 *
 * Only SOAP and REST requests have file locations today — a gRPC or WebSocket request, or an
 * unknown id, returns `undefined`. `dir` and `slug` are derived the same way `serialize.ts`
 * builds its keys, so `${dir}/${slug}.request.yaml` is always a key of `projectFiles(project)`.
 */
export function requestFileLocation(project: Project, requestId: string): RequestFileLocation | undefined {
  for (const iface of project.interfaces) {
    for (const operation of iface.operations) {
      for (const request of operation.requests) {
        if (request.id === requestId) {
          return { dir: `${INTERFACES_DIR}/${iface.slug}/${OPERATIONS_DIR}/${operation.slug}`, slug: request.slug };
        }
      }
    }
  }

  for (const api of project.apis) {
    const base = `${APIS_DIR}/${api.slug}/${REQUESTS_DIR}`;
    for (const request of api.requests) {
      if (request.id === requestId) {
        return { dir: base, slug: request.slug };
      }
    }
    const found = findInFolders(api.folders, base, requestId);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}
