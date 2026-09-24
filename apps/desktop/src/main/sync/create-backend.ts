/**
 * Picks the {@link SyncBackend} for an open shared workspace from its `share.yaml`:
 *
 * - `git` → `GitBackend` when a git executable is found; otherwise a `FolderBackend` that reports
 *   `kind: 'git'`, `gitAvailable: false` and `git-not-found`, so the workspace still opens and
 *   saves as plain files while the status tells the user why nothing syncs.
 * - `folder` → `FolderBackend`, upgraded to `GitBackend` when the folder is itself a git clone
 *   (`<tree>/.git` exists) and git is found.
 * - Before either becomes a `GitBackend`, the repository's local config is checked
 *   (`assertSafeLocalConfig`); a refused key leaves a `FolderBackend` reporting `git-config-refused`.
 * - `server` → a `FolderBackend` placeholder reporting `kind: 'server'` until spec 2's backend.
 *
 * Electron-free, like everything under `sync/`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCli, GitShareSettings, WorkspaceShare } from '@wirebench/engine';
import { WirebenchError, assertSafeLocalConfig } from '@wirebench/engine';
import type { SyncBackend } from './backend.js';
import { FolderBackend } from './folder-backend.js';
import { GitBackend } from './git-backend.js';

export interface CreateSyncBackendOptions {
  readonly share: WorkspaceShare;
  /** The workspace tree the backend operates on. */
  readonly tree: string;
  /** Finds git; `undefined` (or a rejection) means none is available. */
  readonly git: (() => Promise<GitCli | undefined>) | undefined;
  readonly settings: () => GitShareSettings;
  /** Test seam for the `<tree>/.git` check. */
  readonly exists?: (path: string) => boolean;
}

/** The status error a git share reports when no git executable could be found. */
export const GIT_NOT_FOUND_ERROR = {
  code: 'git-not-found',
  message: 'git was not found on this machine. Install git, or choose it in Settings.',
} as const;

export async function createSyncBackend(options: CreateSyncBackendOptions): Promise<SyncBackend> {
  const { share, tree, settings } = options;
  switch (share.kind) {
    case 'server':
      return new FolderBackend({ statusKind: 'server' });
    case 'folder': {
      const exists = options.exists ?? existsSync;
      if (!exists(join(tree, '.git'))) {
        return new FolderBackend();
      }
      const git = await locateGit(options.git);
      if (git === undefined) {
        return new FolderBackend();
      }
      return (await refusedByLocalConfig(git, tree, 'folder')) ?? new GitBackend({ git, tree, settings });
    }
    case 'git': {
      const git = await locateGit(options.git);
      if (git === undefined) {
        return new FolderBackend({ statusKind: 'git', error: GIT_NOT_FOUND_ERROR });
      }
      return (await refusedByLocalConfig(git, tree, 'git')) ?? new GitBackend({ git, tree, settings });
    }
  }
}

/**
 * Checks the tree's `.git/config` against the refused-key list before any other git command runs
 * in it — at every open, since a repository the app joined from a folder (or one edited since) can
 * carry keys that make git run programs. A refusal, or a check that could not run at all, is a
 * status error on a backend that runs no git; `undefined` means the repository is safe to use.
 */
async function refusedByLocalConfig(
  git: GitCli,
  tree: string,
  statusKind: 'git' | 'folder',
): Promise<FolderBackend | undefined> {
  try {
    await assertSafeLocalConfig(git, tree);
    return undefined;
  } catch (error) {
    const code = error instanceof WirebenchError ? error.code : 'git-failed';
    const message = error instanceof Error ? error.message : 'The repository configuration could not be read.';
    return new FolderBackend({ statusKind, error: { code, message } });
  }
}

async function locateGit(git: CreateSyncBackendOptions['git']): Promise<GitCli | undefined> {
  if (git === undefined) {
    return undefined;
  }
  try {
    return await git();
  } catch {
    return undefined;
  }
}
