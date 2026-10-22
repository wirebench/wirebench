/**
 * `share.yaml`: whether (and how) a workspace's tree is shared, kept in the workspace's app-data
 * folder — never inside the tree itself (see `paths.ts`'s `workspaceTreeDir`, spec §4.2). Absent
 * means a local workspace.
 *
 * Mirrors `local-state.ts`'s read/write shape, but unlike that file a corrupt `share.yaml` *is*
 * an error worth surfacing: it names how (and whether) this workspace talks to other machines,
 * so silently treating it as "not shared" would be a data-loss-shaped surprise.
 */

import { join } from 'node:path';
import { parse as parseYamlDocument } from 'yaml';
import { WorkspaceError } from '../errors.js';
import type { FsLike } from '../project/fs.js';
import { nodeFs, readFileIfExists, writeFileAtomic } from '../project/fs.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import { parseWorkspaceFile, workspaceShareSchema } from './schema.js';

/** File name of a workspace's share settings, directly under its app-data folder. */
export const WORKSPACE_SHARE_FILE = 'share.yaml';

/** How a workspace's tree is shared. */
export type ShareKind = 'folder' | 'git' | 'server';

/**
 * The settings `SyncService` and the Sync panel read, whatever carries the sync: how often to
 * fetch, and whether a save commits and pushes (server-sync spec §5.2).
 */
export interface SyncSettings {
  readonly autoFetchSeconds: number;
  readonly commitOnSave: boolean;
  readonly pushOnSave: boolean;
}

/** Defaults a freshly shared git or server workspace is given. */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  autoFetchSeconds: 60,
  commitOnSave: true,
  pushOnSave: true,
};

/** Git-specific share settings, all required once `kind: 'git'` is set (`remote` may still be unset). */
export interface GitShareSettings extends SyncSettings {
  readonly remote?: string;
  readonly branch: string;
}

/** Defaults a freshly-shared git workspace is given. */
export const DEFAULT_GIT_SHARE_SETTINGS: GitShareSettings = {
  ...DEFAULT_SYNC_SETTINGS,
  branch: 'main',
};

/** Wirebench Server share settings (server-sync spec §4.1). */
export interface ServerShareSettings extends SyncSettings {
  /** An http(s) origin, no path — written through the desktop's normalizeServerUrl. */
  readonly url: string;
  /** A ULID (TEAMS_ID_PATTERN); equals workspace.yaml's id. */
  readonly workspaceId: string;
  /** The team's name when shared or joined; display only. */
  readonly teamName?: string;
}

/** `share.yaml`, as loaded (or about to be saved). */
export interface WorkspaceShare {
  readonly version: 1;
  readonly kind: ShareKind;
  /** Absolute path to an externally managed clone/folder; absent means the managed `tree/`. Never set for `server`. */
  readonly path?: string;
  readonly git?: GitShareSettings;
  readonly server?: ServerShareSettings;
}

/** Options shared by {@link loadShare}, {@link saveShare} and {@link deleteShare}. */
export interface ShareOptions {
  readonly fs?: FsLike;
}

/**
 * The sync settings of a git or server share, undefined for a folder share. Only the three shared
 * fields are returned, so a caller cannot come to depend on one kind's extras.
 */
export function shareSyncSettings(share: WorkspaceShare): SyncSettings | undefined {
  const block = share.kind === 'git' ? share.git : share.kind === 'server' ? share.server : undefined;
  if (block === undefined) {
    return undefined;
  }
  return { autoFetchSeconds: block.autoFetchSeconds, commitOnSave: block.commitOnSave, pushOnSave: block.pushOnSave };
}

function shareFile(dir: string): string {
  return join(dir, WORKSPACE_SHARE_FILE);
}

/**
 * Reads `<dir>/share.yaml`. `undefined` when the file does not exist (a local workspace).
 *
 * @throws WorkspaceError `workspace-file-invalid` when the file exists but is not valid YAML or
 * does not match {@link workspaceShareSchema} (e.g. a relative `path`, `kind: 'git'` with no
 * `git` block, or a server block whose `workspaceId` is not a ULID).
 */
export async function loadShare(dir: string, options?: ShareOptions): Promise<WorkspaceShare | undefined> {
  const fs = options?.fs ?? nodeFs;
  const path = shareFile(dir);
  const buffer = await readFileIfExists(fs, path);
  if (buffer === undefined) {
    return undefined;
  }
  let document: unknown;
  try {
    document = parseYamlDocument(buffer.toString('utf8'));
  } catch (error) {
    throw new WorkspaceError('workspace-file-invalid', `Malformed YAML in ${WORKSPACE_SHARE_FILE}`, {
      details: {
        file: WORKSPACE_SHARE_FILE,
        issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
      },
      cause: error,
    });
  }
  const parsed = parseWorkspaceFile(workspaceShareSchema, document, WORKSPACE_SHARE_FILE);
  return {
    version: parsed.version,
    kind: parsed.kind,
    ...(parsed.path !== undefined ? { path: parsed.path } : {}),
    ...(parsed.git !== undefined
      ? {
          git: {
            branch: parsed.git.branch,
            autoFetchSeconds: parsed.git.autoFetchSeconds,
            commitOnSave: parsed.git.commitOnSave,
            pushOnSave: parsed.git.pushOnSave,
            ...(parsed.git.remote !== undefined ? { remote: parsed.git.remote } : {}),
          },
        }
      : {}),
    ...(parsed.server !== undefined
      ? {
          server: {
            url: parsed.server.url,
            workspaceId: parsed.server.workspaceId,
            autoFetchSeconds: parsed.server.autoFetchSeconds,
            commitOnSave: parsed.server.commitOnSave,
            pushOnSave: parsed.server.pushOnSave,
            ...(parsed.server.teamName !== undefined ? { teamName: parsed.server.teamName } : {}),
          },
        }
      : {}),
  };
}

/** Writes `share` to `<dir>/share.yaml` atomically. */
export async function saveShare(dir: string, share: WorkspaceShare, options?: ShareOptions): Promise<void> {
  const fs = options?.fs ?? nodeFs;
  await writeFileAtomic(
    fs,
    shareFile(dir),
    stringifyYaml(
      compact({
        version: share.version,
        kind: share.kind,
        path: share.path,
        git: share.git === undefined ? undefined : compact({ ...share.git }),
        server: share.server === undefined ? undefined : compact({ ...share.server }),
      }),
    ),
  );
}

/** Removes `<dir>/share.yaml`, if present — used when a workspace stops being shared. */
export async function deleteShare(dir: string, options?: ShareOptions): Promise<void> {
  const fs = options?.fs ?? nodeFs;
  await fs.rm(shareFile(dir), { force: true });
}
