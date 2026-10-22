/**
 * Where a request in a tree of folders is written, for a storage facet's `requestLocation`. Kept
 * apart from `request-location.ts`, which asks the registry, so a module can import it.
 */

/** Where a request's files live: `dir` and `slug` such that `${dir}/${slug}.request.yaml` is a project file. */
export interface RequestFileLocation {
  /** POSIX path, relative to the project root. */
  readonly dir: string;
  readonly slug: string;
}

/** A tree of folders and requests, as a REST API and the webhook collection keep theirs. */
export interface RequestTree {
  readonly folders: readonly (RequestTree & { readonly slug: string })[];
  readonly requests: readonly { readonly id: string; readonly slug: string }[];
}

/**
 * Depth-first search of `tree`, whose requests are written under `dir`, for the request with
 * `requestId`; a folder's are under `<dir>/<folder slug>`.
 */
export function locateInTree(tree: RequestTree, dir: string, requestId: string): RequestFileLocation | undefined {
  const request = tree.requests.find((candidate) => candidate.id === requestId);
  if (request !== undefined) return { dir, slug: request.slug };
  for (const folder of tree.folders) {
    const found = locateInTree(folder, `${dir}/${folder.slug}`, requestId);
    if (found !== undefined) return found;
  }
  return undefined;
}
