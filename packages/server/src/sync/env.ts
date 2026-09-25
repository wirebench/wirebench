/**
 * What every server-sync route closes over (spec §5.1), and the one rule the read routes share: a
 * repository that disappeared under a read answers like the guard would (R11).
 */
import type { ServerContext } from '../context.js';
import type { RepoStore } from '../repos/repo-store.js';
import { workspaceNotFound } from '../teams/errors.js';
import type { CommitStore } from './commit-store.js';

export interface SyncEnv {
  readonly ctx: ServerContext;
  readonly store: CommitStore;
}

/**
 * Runs `read` against `workspaceId`'s repository. A workspace delete that won the race after the guard
 * passed has moved the repository away, and git then fails to start in it (`git-not-found`) or fails
 * inside it (`git-failed`). Neither code says "gone", so after any failure the repository is looked up
 * once. If it is missing, the answer is `404 teams-workspace-not-found`, never a 500. Otherwise the
 * original error stands.
 */
export async function whileRepositoryExists<T>(
  repos: RepoStore,
  workspaceId: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
    throw error;
  }
}
