/** One place **Move to…** offers: the API's root (`id` is `''`) or a folder, with how deep it sits. */
export interface MoveTarget {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
}

/** The folder fields the move picker reads. */
interface FolderLike {
  readonly apiId: string;
  readonly parentId?: string | undefined;
  readonly name: string;
  readonly order: number;
}

/**
 * The places a node in API `apiId` can move to, in tree order: the API's root first, then each of its folders
 * under its parent, one level deeper.
 *
 * @param folders - Every folder by id; only `apiId`'s are listed.
 */
export function moveTargets(
  apiId: string,
  apiName: string,
  folders: Readonly<Record<string, FolderLike>>,
): readonly MoveTarget[] {
  const inApi = Object.entries(folders).filter(([, folder]) => folder.apiId === apiId);
  const childrenOf = (parentId: string | undefined): (readonly [string, FolderLike])[] =>
    inApi.filter(([, folder]) => folder.parentId === parentId).sort(([, a], [, b]) => a.order - b.order);
  const targets: MoveTarget[] = [{ id: '', label: apiName, depth: 0 }];
  const walk = (parentId: string | undefined, depth: number): void => {
    for (const [id, folder] of childrenOf(parentId)) {
      targets.push({ id, label: folder.name, depth });
      walk(id, depth + 1);
    }
  };
  walk(undefined, 1);
  return targets;
}
