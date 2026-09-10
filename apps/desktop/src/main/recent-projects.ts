/**
 * The recent-projects list: a small JSON file in Electron's `userData` directory holding the
 * last {@link MAX_RECENT} project folders, most recent first, deduped by directory. Folders
 * that no longer exist are kept in the file but reported as `exists: false`, so the Welcome
 * screen can show them disabled rather than silently forgetting a project on a detached drive.
 *
 * No `electron` import: the caller passes the `userData` directory in, which keeps this
 * unit-testable against a temp folder.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { RecentProject } from '../shared/wire-types.js';

/** Longest the list ever gets; older entries fall off the end. */
export const MAX_RECENT = 10;

/** File name (inside `userData`) the list is persisted to. */
export const RECENT_FILE = 'recent-projects.json';

const storedEntrySchema = z.object({ dir: z.string(), name: z.string(), lastOpenedAt: z.string() });
const storedFileSchema = z.object({ version: z.literal(1), entries: z.array(storedEntrySchema) });

type StoredEntry = z.infer<typeof storedEntrySchema>;

/** Reads and validates the stored list. A missing or corrupt file yields an empty list. */
async function readEntries(file: string): Promise<StoredEntry[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = storedFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? [...parsed.data.entries] : [];
  } catch {
    return [];
  }
}

async function writeEntries(file: string, entries: readonly StoredEntry[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
}

/**
 * Tracks the recent-projects list for one `userData` directory. Every method is safe to call
 * concurrently with itself in the sense that a failure never throws out to the caller's IPC
 * handler — a broken recent list must not stop a project from opening.
 */
export class RecentProjects {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, RECENT_FILE);
  }

  /** The list, most recent first, each entry annotated with whether its folder still exists. */
  async list(): Promise<RecentProject[]> {
    const entries = await readEntries(this.file);
    return entries.map((entry) => ({ ...entry, exists: existsSync(entry.dir) }));
  }

  /**
   * Moves `dir` to the front of the list (updating its name and timestamp), capping the list
   * at {@link MAX_RECENT}. Returns the resulting list.
   */
  async remember(dir: string, name: string, now: Date = new Date()): Promise<RecentProject[]> {
    const entries = await readEntries(this.file);
    const rest = entries.filter((entry) => entry.dir !== dir);
    const next = [{ dir, name, lastOpenedAt: now.toISOString() }, ...rest].slice(0, MAX_RECENT);
    await writeEntries(this.file, next);
    return next.map((entry) => ({ ...entry, exists: existsSync(entry.dir) }));
  }

  /** Drops `dir` from the list, e.g. after the user asked to forget a missing project. */
  async forget(dir: string): Promise<void> {
    const entries = await readEntries(this.file);
    await writeEntries(
      this.file,
      entries.filter((entry) => entry.dir !== dir),
    );
  }
}
