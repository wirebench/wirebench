/**
 * Writes a {@link Workspace} to a workspace folder. Mirrors `project/save.ts`:
 * saving is incremental (only changed files are rewritten) and every write
 * goes through a temp file plus `rename`. Unlike a project, a workspace format
 * carries no backup mechanism, so {@link SaveResult.backups} is always `[]`.
 *
 * Only the workspace's own subtree is managed here (`workspace.yaml` and
 * `environments/*.yaml`); `projects/<slug>` — an internal project's own
 * folder — is owned and saved by the project module, not this one.
 */

import { join } from 'node:path';
import type { SaveResult } from '../project/save.js';
import type { FsLike } from '../project/fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from '../project/fs.js';
import type { Workspace } from './model.js';
import { WORKSPACE_ENVIRONMENTS_DIR, WORKSPACE_MANIFEST } from './paths.js';
import type { WorkspaceFiles } from './serialize.js';
import { workspaceFiles } from './serialize.js';

/** Options for {@link saveWorkspace}. */
export interface SaveWorkspaceOptions {
  /**
   * The files as they were last written. When supplied, unchanged files are
   * detected without reading them back from disk; when omitted, the current
   * on-disk bytes are read and compared instead.
   */
  readonly previous?: WorkspaceFiles;
  readonly fs?: FsLike;
}

function toAbsolute(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

/**
 * Lists every file this format manages under `root`: `workspace.yaml` and
 * `environments/*.yaml`. Anything else — a README, a foreign file dropped
 * into `environments/` — is never a deletion candidate.
 */
async function listManagedFiles(fs: FsLike, root: string): Promise<string[]> {
  const managed: string[] = [];
  if ((await readFileIfExists(fs, toAbsolute(root, WORKSPACE_MANIFEST))) !== undefined) {
    managed.push(WORKSPACE_MANIFEST);
  }
  for (const entry of await readdirIfExists(fs, toAbsolute(root, WORKSPACE_ENVIRONMENTS_DIR))) {
    if (entry.isFile && entry.name.endsWith('.yaml')) {
      managed.push(`${WORKSPACE_ENVIRONMENTS_DIR}/${entry.name}`);
    }
  }
  return managed;
}

/**
 * Saves `workspace` into the directory `root`, creating it if needed.
 *
 * @returns which files were written, removed and left untouched. `backups` is
 * always `[]` — the workspace format has none.
 */
export async function saveWorkspace(
  workspace: Workspace,
  root: string,
  options?: SaveWorkspaceOptions,
): Promise<SaveResult> {
  const fs = options?.fs ?? nodeFs;
  const desired = workspaceFiles(workspace);
  const existing = await listManagedFiles(fs, root);

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const [relative, content] of desired) {
    const absolute = toAbsolute(root, relative);
    // When a `previous` map was supplied, trust it as the full picture (a missing key means
    // "not previously written", not "go check disk"); only fall back to a real disk read when
    // no `previous` map was given at all.
    const previous =
      options?.previous?.get(relative) ??
      (options?.previous !== undefined ? undefined : (await readFileIfExists(fs, absolute))?.toString('utf8'));
    if (previous === content) {
      unchanged.push(relative);
      continue;
    }
    await writeFileAtomic(fs, absolute, Buffer.from(content, 'utf8'));
    written.push(relative);
  }

  const removed: string[] = [];
  let environmentsDirTouched = false;
  for (const relative of existing) {
    if (desired.has(relative)) {
      continue;
    }
    await fs.rm(toAbsolute(root, relative), { force: true });
    removed.push(relative);
    if (relative.startsWith(`${WORKSPACE_ENVIRONMENTS_DIR}/`)) {
      environmentsDirTouched = true;
    }
  }
  if (environmentsDirTouched) {
    const remaining = await readdirIfExists(fs, toAbsolute(root, WORKSPACE_ENVIRONMENTS_DIR));
    if (remaining.length === 0) {
      await fs.rm(toAbsolute(root, WORKSPACE_ENVIRONMENTS_DIR), { recursive: true, force: true });
      removed.push(WORKSPACE_ENVIRONMENTS_DIR);
    }
  }

  written.sort();
  removed.sort();
  unchanged.sort();
  return { written, removed, unchanged, backups: [] };
}
