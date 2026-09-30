/**
 * Walking a container's tree of folders and requests, as the REST, gRPC and WebSocket modules all
 * keep one. Core code: it names no protocol.
 */

/** Explorer order: by `order`, then by name. */
export const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

/** Why a request its contract no longer has cannot be a sequence step. */
export const ORPHANED_STEP_REASON = 'The request is no longer in its contract (orphaned)';

/** What a tree's request has, as far as the walk cares. */
export interface TreeRequest {
  readonly order: number;
  readonly name: string;
  readonly slug: string;
}

/** What a tree's folder has, as far as the walk cares. */
export interface TreeFolder<F, R> {
  readonly order: number;
  readonly name: string;
  readonly slug: string;
  readonly folders: readonly F[];
  readonly requests: readonly R[];
}

/** A folder's request or sub-folder child, tagged so the sort below need not narrow a union. */
type TreeChild<F, R> =
  | { readonly tag: 'request'; readonly order: number; readonly name: string; readonly request: R }
  | { readonly tag: 'folder'; readonly order: number; readonly name: string; readonly folder: F };

/**
 * Walks a request tree in explorer order. `make` turns a request the protocol can run into its
 * selection, or answers `undefined` for one it skips (orphaned, streaming). Each selection is pushed
 * to `out` with the request's path on disk, without the `.request.yaml` suffix.
 */
export function walkTree<F extends TreeFolder<F, R>, R extends TreeRequest, S>(
  node: { readonly folders: readonly F[]; readonly requests: readonly R[] },
  chain: readonly F[],
  group: string,
  diskDir: string,
  make: (request: R, chain: readonly F[], group: string) => S | undefined,
  out: { item: S; diskPath: string }[],
): void {
  const children: TreeChild<F, R>[] = [
    ...node.requests.map((request): TreeChild<F, R> => ({
      tag: 'request',
      order: request.order,
      name: request.name,
      request,
    })),
    ...node.folders.map((folder): TreeChild<F, R> => ({
      tag: 'folder',
      order: folder.order,
      name: folder.name,
      folder,
    })),
  ].sort(byOrder);
  for (const child of children) {
    if (child.tag === 'request') {
      const item = make(child.request, chain, group);
      if (item !== undefined) {
        out.push({ item, diskPath: `${diskDir}/${child.request.slug}` });
      }
    } else {
      walkTree(
        child.folder,
        [...chain, child.folder],
        `${group}/${child.folder.name}`,
        `${diskDir}/${child.folder.slug}`,
        make,
        out,
      );
    }
  }
}

/** A tree of folders and requests, as far as a lookup by id cares. */
export interface RequestTree<R extends { readonly id: string } = { readonly id: string }> {
  readonly folders: readonly RequestTree<R>[];
  readonly requests: readonly R[];
}

/** The request with `id` anywhere in `tree`, depth-first. */
export function findInTree<R extends { readonly id: string }>(tree: RequestTree<R>, id: string): R | undefined {
  const own = tree.requests.find((request) => request.id === id);
  if (own !== undefined) {
    return own;
  }
  for (const folder of tree.folders) {
    const found = findInTree(folder, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
