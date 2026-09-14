/**
 * Small file helpers shared by `workspace-service.ts` and `workspace-share.ts` — kept apart so the
 * share operations never import the service module (which imports them).
 */

import { existsSync } from 'node:fs';
import { cp, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  attachmentsDir,
  definitionCacheDir,
  INTERFACES_DIR,
  loadShare,
  WorkspaceError,
  workspaceTreeDir,
} from '@wirebench/engine';
import type { FsLike, WorkspaceShare } from '@wirebench/engine';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Workspace ids are ULIDs, and a workspace id is also a *folder name* — so anything that is
 * not one is refused before it can reach `join`. The id is the one workspace value that comes
 * straight from the renderer (the picker sends back a row's id), which is exactly why it is
 * checked here rather than trusted: `../../etc` must never become a path.
 */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns `id` when it is usable as a single folder name.
 *
 * @throws WorkspaceError `workspace-path-invalid` otherwise.
 */
export function requireWorkspaceId(id: string): string {
  if (!WORKSPACE_ID.test(id)) {
    throw new WorkspaceError('workspace-path-invalid', `Not a workspace id: ${JSON.stringify(id)}`, {
      details: { workspaceId: id },
    });
  }
  return id;
}

/** Throws unless `path` is an absolute filesystem path — a relative linked ref is a corrupt ref. */
export function requireAbsolute(path: string | undefined, slug: string): string {
  if (path === undefined || !isAbsolute(path)) {
    throw new WorkspaceError('workspace-path-invalid', `Linked project "${slug}" has no absolute path.`, {
      details: { slug, path },
    });
  }
  return path;
}

/** Copies a directory tree verbatim when it is there, and does nothing when it is not. */
export async function copyTreeIfPresent(source: string, target: string): Promise<void> {
  if (!existsSync(source)) {
    return;
  }
  await cp(source, target, { recursive: true });
}

/**
 * Copies the parts of a project folder that `projectFiles` does not describe: the attachment
 * blobs and every interface's `definition/` cache.
 *
 * `saveProject` writes the *model* — the YAML the project is defined by. The bytes the user
 * attached and the WSDL/XSD documents the definition cache holds are not in that model, so a
 * copy made with `saveProject` alone would open with every interface un-hydrated and every
 * attachment gone. They are copied byte-for-byte rather than re-fetched: an export must not
 * depend on the original service still being reachable.
 */
export async function copyProjectPayload(source: string, target: string): Promise<void> {
  await copyTreeIfPresent(attachmentsDir(source), attachmentsDir(target));
  let interfaces: string[];
  try {
    interfaces = (await readdir(join(source, INTERFACES_DIR), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const slug of interfaces) {
    await copyTreeIfPresent(definitionCacheDir(source, slug), definitionCacheDir(target, slug));
  }
}

/**
 * Whether `dir` holds nothing (a folder that does not exist counts as empty).
 *
 * Only `ENOENT` is "empty". Any other `readdir` failure — a folder the app may not read, an I/O
 * error — is raised: a target that cannot be listed is not known to be empty, and treating it as
 * empty is how export (or share to folder) would write over files it never saw.
 */
export async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

/**
 * A workspace app-data directory's `share.yaml` (or `undefined` for a local one) and the tree
 * root it points at — the one lookup every place that reads a workspace from disk makes.
 */
export async function resolveWorkspaceTree(
  dir: string,
  options?: { fs: FsLike },
): Promise<{ share: WorkspaceShare | undefined; tree: string }> {
  const share = await loadShare(dir, options);
  return { share, tree: workspaceTreeDir(dir, share) };
}
