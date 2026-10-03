/**
 * Reads a request's golden response: the `<slug>.golden.yaml` sidecar beside its request file
 * (snapshot regression, #34). Shared by the desktop's Snapshot tab and the runner's `--baseline`
 * (#36), so the file is read one way. Uses `node:fs`, so it is exported from the main entry only —
 * never from the `@wirebench/engine/snapshot` subpath, which the renderer imports.
 */

import { constants, existsSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parse as parseYamlText } from 'yaml';
import { z } from 'zod';
import type { Project } from '../project/model.js';
import { requestFileLocation } from '../project/request-location.js';

export interface GoldenFile {
  readonly contentType?: string;
  readonly savedAt: string;
  readonly ignore: readonly string[];
  readonly body: string;
}

export type GoldenRead =
  | { readonly status: 'none' }
  | { readonly status: 'present'; readonly golden: GoldenFile }
  | { readonly status: 'unreadable'; readonly reason: 'not-a-file' | 'malformed' };

const goldenFileSchema = z.object({
  contentType: z.string().optional(),
  savedAt: z.string(),
  ignore: z.array(z.string()),
  body: z.string(),
});

const NONE: GoldenRead = { status: 'none' };
const NOT_A_FILE: GoldenRead = { status: 'unreadable', reason: 'not-a-file' };
const MALFORMED: GoldenRead = { status: 'unreadable', reason: 'malformed' };

/** Read-only, never through a link, never blocking on a FIFO; Windows defines neither extra flag. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** `path` with `realpath` resolved through whatever prefix of it exists, so a symlink cannot hide an escape. */
async function realpathOfPrefix(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    const real = await realpath(current);
    return tail.length === 0 ? real : join(real, ...tail);
  } catch {
    return path;
  }
}

/** True when `candidate` is `root` or below it; both real paths. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The golden saved for `requestId` in the project saved at `projectDir`. `none` when the request
 * has no file location, its folder leaves the project, its `*.request.yaml` is not on disk, or no
 * sidecar exists. The sidecar's own name is checked with `lstat`, never followed, and read through
 * the one handle that was checked.
 */
export async function readGoldenFile(projectDir: string, project: Project, requestId: string): Promise<GoldenRead> {
  const location = requestFileLocation(project, requestId);
  if (location === undefined) return NONE;
  const folder = join(projectDir, ...location.dir.split('/'));
  const requestFile = join(folder, `${location.slug}.request.yaml`);
  const [root, requestReal, folderReal] = await Promise.all([
    realpathOfPrefix(projectDir),
    realpathOfPrefix(requestFile),
    realpathOfPrefix(folder),
  ]);
  if (!isInside(root, requestReal) || !isInside(root, folderReal) || !existsSync(requestFile)) return NONE;

  const file = join(folderReal, `${location.slug}.golden.yaml`);
  let checked;
  try {
    checked = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NONE;
    throw error;
  }
  if (!checked.isFile()) return NOT_A_FILE;

  // The path may change after the lstat: open it without following a link, then check the handle
  // is the file lstat saw. Where O_NOFOLLOW is missing (Windows), a followed link fails that check.
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return NONE;
    if (code === 'ELOOP') return NOT_A_FILE;
    return MALFORMED;
  }
  let parsed;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) return NOT_A_FILE;
    parsed = goldenFileSchema.safeParse(parseYamlText(await handle.readFile('utf8')));
  } catch {
    return MALFORMED;
  } finally {
    await handle.close();
  }
  if (!parsed.success) return MALFORMED;
  const { contentType, savedAt, ignore, body } = parsed.data;
  return {
    status: 'present',
    golden: { ...(contentType !== undefined ? { contentType } : {}), savedAt, ignore, body },
  };
}
