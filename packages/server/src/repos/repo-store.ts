/**
 * Bare repositories, one per workspace, under `<dataDir>/repos/<workspaceId>.git` (host spec §3.5).
 * Paths derive from a validated ULID and nothing else (ADR-0005 applied server-side). Hooks can
 * never run: every repository's `core.hooksPath` is an empty directory the server owns. Removal
 * moves; it never deletes.
 */
import { access, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GitCli, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** Sync spec R11: new repository work after shutdown began; a client retries against the next process. */
const shuttingDown = (): WirebenchError =>
  problem('server-shutting-down', 'The server is shutting down. Try again in a moment.', 503);

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
  /** Set by {@link drain}; from then on {@link withLock} refuses new work. */
  private draining = false;

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

  /**
   * Initialises the repository in `tmp/` and renames it into `repos/` (teams-access spec §3.7): a
   * crash or a failing git step leaves a stray `tmp/creating-…` directory, never a half-built
   * repository at the path the workspace id names. Callers run it inside {@link withLock}.
   */
  async create(workspaceId: string): Promise<void> {
    const dir = this.path(workspaceId);
    if (await this.exists(workspaceId)) {
      throw problem('server-repo-exists', 'A repository for this workspace already exists.', 409);
    }
    const staging = join(this.dataDir, TMP_DIR, `creating-${workspaceId}-${randomBytes(4).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    await this.git.run(staging, [GIT.init, '--bare', '--quiet']);
    await this.git.run(staging, [GIT.symbolicRef, 'HEAD', 'refs/heads/main']);
    await this.git.run(staging, [GIT.config, 'core.hooksPath', join(this.dataDir, NO_HOOKS_DIR)]);
    await this.git.run(staging, [GIT.config, 'receive.denyNonFastForwards', 'true']);
    await rename(staging, dir);
  }

  async remove(workspaceId: string): Promise<void> {
    const dir = this.path(workspaceId);
    await rename(dir, join(this.dataDir, TMP_DIR, `removed-${workspaceId}-${Date.now()}`));
  }

  /**
   * One operation per workspace at a time, FIFO, in-process (spec assumption 1). Once {@link drain}
   * has begun it refuses with `server-shutting-down` (503) as a rejected promise, never a throw:
   * callers chain `.catch` on it (the workspace-create cleanup does), and a synchronous throw would
   * escape that. An invalid id still throws at once, as a programming error.
   */
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.assertId(workspaceId);
    if (this.draining) return Promise.reject(shuttingDown());
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

  /**
   * Host spec §3.7, sync spec R11: shutdown stops new repository work and waits for what is queued.
   * A handler keeps running after the drain deadline drops its connection, so the database pool must
   * outlive the repository work, not only the request. Each queue entry is the settled tail of that
   * workspace's chain (it never rejects), so this resolves once every queued operation has finished,
   * whatever its outcome. Calling it again waits for whatever is still queued.
   */
  drain(): Promise<void> {
    this.draining = true;
    return Promise.all(this.queues.values()).then(() => undefined);
  }
}
