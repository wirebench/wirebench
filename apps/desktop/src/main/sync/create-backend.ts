/**
 * Picks the {@link SyncBackend} for an open shared workspace from its `share.yaml`:
 *
 * - `git` → `GitBackend` when a git executable is found; otherwise a `FolderBackend` that reports
 *   `kind: 'git'`, `gitAvailable: false` and `git-not-found`, so the workspace still opens and
 *   saves as plain files while the status tells the user why nothing syncs.
 * - `folder` → `FolderBackend`, upgraded to `GitBackend` when the folder is itself a git clone
 *   (`<tree>/.git` exists) and git is found.
 * - `server` → a `FolderBackend` placeholder reporting `kind: 'server'` until spec 2's backend.
 *
 * Electron-free, like everything under `sync/`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitShareSettings, WorkspaceShare } from '@wirebench/engine';
import type { SyncBackend } from './backend.js';
import { FolderBackend } from './folder-backend.js';
import { GitBackend } from './git-backend.js';
import type { GitCli } from './git-cli.js';

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
      return git === undefined ? new FolderBackend() : new GitBackend({ git, tree, settings });
    }
    case 'git': {
      const git = await locateGit(options.git);
      return git === undefined
        ? new FolderBackend({ statusKind: 'git', error: GIT_NOT_FOUND_ERROR })
        : new GitBackend({ git, tree, settings });
    }
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
