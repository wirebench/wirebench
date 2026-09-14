/**
 * File-system naming and layout for a workspace folder.
 *
 * Mirrors `project/paths.ts`: display names live inside the YAML, the
 * folder/file names are derived slugs. `assertPathSegment` is workspace's own
 * (not `project`'s) so a corrupted slug always throws a `WorkspaceError`.
 */

import { join } from 'node:path';
import { WorkspaceError } from '../errors.js';
import type { WorkspaceShare } from './share.js';

/** Device names Windows refuses to use as a file name, with or without an extension. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Rejects a value that cannot safely be used as a single path segment on disk:
 * empty, `.`/`..`, containing a path separator or NUL, leading/trailing
 * whitespace or dots, or a Windows reserved device name. Used to validate any
 * slug that flows into a workspace file path before it is ever written to (or
 * deleted from) disk.
 *
 * @throws WorkspaceError `workspace-path-invalid` carrying the offending segment.
 */
export function assertPathSegment(segment: string): void {
  const invalid =
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\u0000') ||
    /^[. ]/.test(segment) ||
    /[. ]$/.test(segment) ||
    RESERVED_NAMES.test(segment);
  if (invalid) {
    throw new WorkspaceError('workspace-path-invalid', `Invalid path segment: ${JSON.stringify(segment)}`, {
      details: { segment },
    });
  }
}

/** Directory (under a user-data root) holding every workspace. */
export const WORKSPACES_DIR = 'workspaces';
/** File name of a workspace's manifest. */
export const WORKSPACE_MANIFEST = 'workspace.yaml';
/** Directory holding every workspace environment file. */
export const WORKSPACE_ENVIRONMENTS_DIR = 'environments';
/** Directory holding every internal project's folder. */
export const WORKSPACE_PROJECTS_DIR = 'projects';
/** File name of the (non-managed-format) file recording desktop UI state, e.g. the last opened workspace. */
export const WORKSPACE_STATE_FILE = 'workspace-state.json';
/** Directory (under a workspace's app-data folder) holding a managed git/folder share's clone. */
export const WORKSPACE_TREE_DIR = 'tree';
/** Directory a clone is checked out into while `join` is still in progress, before it is renamed into place. */
export const WORKSPACE_JOINING_DIR = '.joining';
/** File name of the tree's own `.gitattributes`, written on share and on join if missing. */
export const GIT_ATTRIBUTES_FILE = '.gitattributes';
/**
 * Contents of {@link GIT_ATTRIBUTES_FILE}: normalises line endings, and leaves bytes alone where
 * they must stay exact — attachments, and definition caches, whose manifest records each
 * document's SHA-256 as fetched (a CRLF definition normalised by git fails that check on the
 * other side, which then re-fetches and rewrites the cache).
 */
export const GIT_ATTRIBUTES =
  '* text=auto eol=lf\n*.yaml text\n*.xml text\n*.wsdl text\n*.xsd text\nprojects/*/attachments/** -text\nprojects/*/interfaces/*/definition/** -text\n';

/** Absolute path of a workspace's own directory, given the app's user-data root and the workspace id. */
export function workspaceDir(userDataDir: string, workspaceId: string): string {
  return join(userDataDir, WORKSPACES_DIR, workspaceId);
}

/** Absolute path of a workspace's manifest. */
export function workspaceManifestFile(dir: string): string {
  return join(dir, WORKSPACE_MANIFEST);
}

/**
 * Absolute path of a workspace environment file.
 *
 * @throws WorkspaceError `workspace-path-invalid` (via {@link assertPathSegment}) when `slug` is not a safe path segment.
 */
export function workspaceEnvironmentFile(dir: string, slug: string): string {
  assertPathSegment(slug);
  return join(dir, WORKSPACE_ENVIRONMENTS_DIR, `${slug}.yaml`);
}

/**
 * Absolute path of an internal project's directory inside a workspace.
 *
 * @throws WorkspaceError `workspace-path-invalid` (via {@link assertPathSegment}) when `slug` is not a safe path segment.
 */
export function workspaceProjectDir(dir: string, slug: string): string {
  assertPathSegment(slug);
  return join(dir, WORKSPACE_PROJECTS_DIR, slug);
}

/**
 * The root of a workspace's tree — where `workspace.yaml`, `environments/` and `projects/`
 * actually live. For a `local` workspace (`share === undefined`) that is `dir` itself; for a
 * shared workspace it is `share.path` when the tree lives outside `dir` (an external git clone
 * or synced folder), or the managed `<dir>/tree` clone otherwise.
 */
export function workspaceTreeDir(dir: string, share: WorkspaceShare | undefined): string {
  if (share === undefined) {
    return dir;
  }
  return share.path ?? join(dir, WORKSPACE_TREE_DIR);
}
