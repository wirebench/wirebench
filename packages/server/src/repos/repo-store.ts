/**
 * Bare repositories, one per workspace, under `<dataDir>/repos/<workspaceId>.git` (host spec §3.5).
 * Paths derive from a validated ULID and nothing else (ADR-0005 applied server-side). Hooks can
 * never run: every repository's `core.hooksPath` is an empty directory the server owns. Removal
 * moves; it never deletes.
 */
import { access, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GitCli } from '@wirebench/engine';
import { problem } from '../problem.js';

export const NO_HOOKS_DIR = 'no-hooks';
const REPOS_DIR = 'repos';
const TMP_DIR = 'tmp';

/** Crockford base32 ULID, upper case, 26 characters — what `ulidx` mints. */
const WORKSPACE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID.test(value);
}

/** The git subcommands this store runs; the allow-list is `GIT_SUBCOMMANDS` in the engine. */
const GIT = { init: 'init', config: 'config', symbolicRef: 'symbolic-ref' } as const;

export class RepoStore {
  private readonly git: GitCli;
  private readonly dataDir: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(deps: { readonly git: GitCli; readonly dataDir: string }) {
    this.git = deps.git;
    this.dataDir = resolve(deps.dataDir);
  }

  /** Creates the three directories the store needs; called once at start-up. */
  static async prepare(dataDir: string): Promise<void> {
    for (const dir of [REPOS_DIR, TMP_DIR, NO_HOOKS_DIR]) {
      await mkdir(join(dataDir, dir), { recursive: true });
    }
  }

  private assertId(workspaceId: string): void {
    if (!isWorkspaceId(workspaceId)) {
      throw problem('server-workspace-id-invalid', 'Workspace ids are 26-character ULIDs.', 400);
    }
  }

  path(workspaceId: string): string {
    this.assertId(workspaceId);
    return join(this.dataDir, REPOS_DIR, `${workspaceId}.git`);
  }

  exists(workspaceId: string): Promise<boolean> {
    return access(join(this.path(workspaceId), 'HEAD')).then(
      () => true,
      () => false,
    );
  }

  async create(workspaceId: string): Promise<void> {
    const dir = this.path(workspaceId);
    if (await this.exists(workspaceId)) {
      throw problem('server-repo-exists', 'A repository for this workspace already exists.', 409);
    }
    await mkdir(dir, { recursive: true });
    await this.git.run(dir, [GIT.init, '--bare', '--quiet']);
    await this.git.run(dir, [GIT.symbolicRef, 'HEAD', 'refs/heads/main']);
    await this.git.run(dir, [GIT.config, 'core.hooksPath', join(this.dataDir, NO_HOOKS_DIR)]);
    await this.git.run(dir, [GIT.config, 'receive.denyNonFastForwards', 'true']);
  }

  async remove(workspaceId: string): Promise<void> {
    const dir = this.path(workspaceId);
    await rename(dir, join(this.dataDir, TMP_DIR, `removed-${workspaceId}-${Date.now()}`));
  }

  /** One operation per workspace at a time, FIFO, in-process (spec assumption 1). */
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.assertId(workspaceId);
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(workspaceId, settled);
    void settled.then(() => {
      if (this.queues.get(workspaceId) === settled) this.queues.delete(workspaceId);
    });
    return run;
  }
}
