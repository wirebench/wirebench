/**
 * The desktop's small memory of *which* workspace was last open, and when each one was last
 * opened — `<userData>/workspace-state.json`.
 *
 * Deliberately NOT a managed format: the truth about what workspaces exist is the directory
 * scan of `<userData>/workspaces/*` (see `workspace-service.ts`). This file only decorates
 * that scan, so a missing, malformed or unexpectedly-shaped file yields an empty state rather
 * than an error: broken UI state must never stop the app from starting or a workspace from
 * opening.
 *
 * Written atomically (temp file renamed over the target), so a crash mid-write cannot leave a
 * half-written document behind.
 *
 * No `electron` import — the caller passes the `userData` directory in, which keeps this
 * unit-testable against a temp folder.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WORKSPACE_STATE_FILE } from '@wirebench/engine';

/** Format version of `workspace-state.json`; an incompatible document reads as empty state. */
export const WORKSPACE_STATE_VERSION = 1;

const stateSchema = z.object({
  version: z.literal(WORKSPACE_STATE_VERSION),
  /** The workspace `openLast()` reopens. Absent before the first open, or after it was deleted. */
  lastOpenedWorkspaceId: z.string().optional(),
  /**
   * When each workspace was last opened, keyed by workspace id. Kept as a map (rather than only
   * the single last-opened stamp) because the picker sorts its rows by it, and that has to work
   * for every workspace on disk, not just the most recent one.
   */
  lastOpenedAt: z.record(z.string(), z.string()).default({}),
});

/** The contents of `workspace-state.json`, as read back. */
export type WorkspaceStateDocument = z.infer<typeof stateSchema>;

/** The state an unreadable, missing or corrupt file reads as. */
const EMPTY: WorkspaceStateDocument = { version: WORKSPACE_STATE_VERSION, lastOpenedAt: {} };

/** Writes `data` to `path` via a sibling temp file renamed over the target. */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Reads and writes `<userData>/workspace-state.json`.
 *
 * Every mutator re-reads the file before writing, so two overlapping calls cannot persist
 * stale snapshots over one another. No method throws on a corrupt file.
 */
export class WorkspaceState {
  private readonly file: string;
  /** Serialises writes: each one chains off this promise rather than racing the read-modify-write. */
  private queue: Promise<void> = Promise.resolve();

  constructor(userDataDir: string) {
    this.file = join(userDataDir, WORKSPACE_STATE_FILE);
  }

  /** The stored state; empty when the file is missing, unreadable or does not validate. */
  async read(): Promise<WorkspaceStateDocument> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return EMPTY;
    }
    try {
      const parsed = stateSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  /** Runs `mutate` against the current state and persists the result, one write at a time. */
  private update(mutate: (state: WorkspaceStateDocument) => WorkspaceStateDocument): Promise<void> {
    const next = this.queue.then(
      async () => {
        const state = mutate(await this.read());
        await writeAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      },
      () => undefined,
    );
    // Never rejects, so one failed write does not poison every later one; the caller still sees
    // the rejection through the promise it was handed.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Records `workspaceId` as the last opened one, stamping `at` into the history map. */
  async remember(workspaceId: string, at: string): Promise<void> {
    await this.update((state) => ({
      ...state,
      lastOpenedWorkspaceId: workspaceId,
      lastOpenedAt: { ...state.lastOpenedAt, [workspaceId]: at },
    }));
  }

  /** Drops every trace of `workspaceId` — called after it is moved to the trash. */
  async forget(workspaceId: string): Promise<void> {
    await this.update((state) => {
      const rest = Object.fromEntries(Object.entries(state.lastOpenedAt).filter(([id]) => id !== workspaceId));
      const last = state.lastOpenedWorkspaceId === workspaceId ? undefined : state.lastOpenedWorkspaceId;
      return {
        version: WORKSPACE_STATE_VERSION,
        ...(last !== undefined ? { lastOpenedWorkspaceId: last } : {}),
        lastOpenedAt: rest,
      };
    });
  }
}
