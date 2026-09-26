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
 * - `server` → a `ServerBackend` (server-sync §3.1) over the app's `ServerClient` and accounts,
 *   keeping its state in `<dir>/server`. It runs no git. Without those services a `FolderBackend`
 *   reports `kind: 'server'` with `sync-not-supported`, and the workspace still opens on its files.
 *
 * Electron-free, like everything under `sync/`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCli, GitShareSettings, WorkspaceShare } from '@wirebench/engine';
import { WirebenchError, assertSafeLocalConfig } from '@wirebench/engine';
import type { ServerClient } from '../server-client.js';
import type { AccountService } from '../account-service.js';
import type { LiveClients } from '../live/live-clients.js';
import type { TokenSource } from '../server-token.js';
import type { SyncBackend } from './backend.js';
import { FolderBackend } from './folder-backend.js';
import { GitBackend } from './git-backend.js';
import { ServerBackend } from './server-backend.js';
import { SERVER_STATE_DIR, ServerState } from './server-state.js';

/**
 * What a server share's backend talks through: the app's one client, and the accounts' tokens (§5.3).
 * `list` finds the signed-in account for the share's URL, whose name and email are the default commit
 * identity (§3.1), so a signed-in user is never asked for one. `live`, the app's live sockets
 * (live-updates §5.3), turns a teammate's push or an access change into a fetch within seconds.
 * Without it the share polls, as it did before.
 */
export interface ServerSyncServices {
  readonly client: ServerClient;
  readonly accounts: TokenSource & Pick<AccountService, 'list'>;
  readonly live?: Pick<LiveClients, 'subscribe'>;
}

export interface CreateSyncBackendOptions {
  readonly share: WorkspaceShare;
  /** The workspace tree the backend operates on. */
  readonly tree: string;
  /** Finds git; `undefined` (or a rejection) means none is available. */
  readonly git: (() => Promise<GitCli | undefined>) | undefined;
  /** A git share's settings, read by `GitBackend` (branch and remote). */
  readonly settings: () => GitShareSettings;
  /** Test seam for the `<tree>/.git` check. */
  readonly exists?: (path: string) => boolean;
  /** The client and accounts a `server` share syncs through; omitted where no server share can sync. */
  readonly server?: ServerSyncServices;
  /** `<userData>/workspaces/<id>`: a `server` share keeps its state in `<dir>/server`. Required for kind `server`. */
  readonly dir?: string;
}

/** The status error a git share reports when no git executable could be found. */
export const GIT_NOT_FOUND_ERROR = {
  code: 'git-not-found',
  message: 'git was not found on this machine. Install git, or choose it in Settings.',
} as const;

/** The status error a server share reports when it was opened without the server services to sync it. */
export const SERVER_SYNC_UNAVAILABLE_ERROR = {
  code: 'sync-not-supported',
  message: 'Syncing with Wirebench Server is not available here.',
} as const;

export async function createSyncBackend(options: CreateSyncBackendOptions): Promise<SyncBackend> {
  const { share, tree, settings } = options;
  switch (share.kind) {
    case 'server': {
      const { server, dir } = options;
      if (server === undefined || dir === undefined || share.server === undefined) {
        return new FolderBackend({ statusKind: 'server', error: SERVER_SYNC_UNAVAILABLE_ERROR });
      }
      const { url, workspaceId } = share.server;
      return new ServerBackend({
        client: server.client,
        accounts: server.accounts,
        url,
        workspaceId,
        tree,
        state: new ServerState(join(dir, SERVER_STATE_DIR)),
        defaultIdentity: () => {
          const account = server.accounts
            .list()
            .find((candidate) => candidate.url === url && candidate.signedOut !== true);
          return account === undefined ? undefined : { name: account.displayName, email: account.email };
        },
        ...(server.live !== undefined ? { live: server.live } : {}),
      });
    }
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
