/**
 * Reads and writes a request's golden response: the `<slug>.golden.yaml` sidecar beside its request
 * file (snapshot regression, #34). Shared by the desktop's Snapshot tab and the runner's `--baseline`
 * (#36) and `--update-baseline` (#217), so the file is read and written one way. Uses `node:fs`, so it is exported from the main entry only —
 * never from the `@wirebench/engine/snapshot` subpath, which the renderer imports.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Document, parse as parseYamlText } from 'yaml';
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

/** Where `requestId`'s sidecar goes once containment and the request file are checked; `undefined` is "unsaved". */
async function sidecarOf(
  projectDir: string,
  project: Project,
  requestId: string,
): Promise<{ readonly file: string; readonly relative: string } | undefined> {
  const location = requestFileLocation(project, requestId);
  if (location === undefined) return undefined;
  const folder = join(projectDir, ...location.dir.split('/'));
  const requestFile = join(folder, `${location.slug}.request.yaml`);
  const [root, requestReal, folderReal] = await Promise.all([
    realpathOfPrefix(projectDir),
    realpathOfPrefix(requestFile),
    realpathOfPrefix(folder),
  ]);
  if (!isInside(root, requestReal) || !isInside(root, folderReal) || !existsSync(requestFile)) return undefined;
  const name = `${location.slug}.golden.yaml`;
  return { file: join(folderReal, name), relative: location.dir === '' ? name : `${location.dir}/${name}` };
}

/**
 * The golden saved for `requestId` in the project saved at `projectDir`. `none` when the request
 * has no file location, its folder leaves the project, its `*.request.yaml` is not on disk, or no
 * sidecar exists. The sidecar's own name is checked with `lstat` and never followed.
 */
export async function readGoldenFile(projectDir: string, project: Project, requestId: string): Promise<GoldenRead> {
  const sidecar = await sidecarOf(projectDir, project, requestId);
  if (sidecar === undefined) return NONE;
  const file = sidecar.file;
  try {
    if (!(await lstat(file)).isFile()) return { status: 'unreadable', reason: 'not-a-file' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NONE;
    throw error;
  }

  let parsed;
  try {
    parsed = goldenFileSchema.safeParse(parseYamlText(await readFile(file, 'utf8')));
  } catch {
    return { status: 'unreadable', reason: 'malformed' };
  }
  if (!parsed.success) return { status: 'unreadable', reason: 'malformed' };
  const { contentType, savedAt, ignore, body } = parsed.data;
  return {
    status: 'present',
    golden: { ...(contentType !== undefined ? { contentType } : {}), savedAt, ignore, body },
  };
}

export type GoldenWrite =
  | { readonly status: 'written'; readonly file: string }
  | { readonly status: 'refused'; readonly reason: 'unsaved' | 'not-a-file' };

/**
 * `golden` as sidecar text, keys sorted, the body a block scalar so a golden diffs well in git. A
 * block scalar cannot hold every string — a whitespace-only body such as `"  \n"` reads back
 * differently — so the text is parsed back, and a body that does not survive is double-quoted.
 */
function goldenText(golden: GoldenFile): string {
  const doc = new Document(
    {
      ...(golden.contentType !== undefined ? { contentType: golden.contentType } : {}),
      savedAt: golden.savedAt,
      ignore: [...golden.ignore],
      body: golden.body,
    },
    { sortMapEntries: true },
  );
  const body = doc.get('body', true) as { type?: string };
  body.type = 'BLOCK_LITERAL';
  const text = doc.toString({ lineWidth: 0 });
  if ((parseYamlText(text) as { body?: unknown }).body === golden.body) return text;
  body.type = 'QUOTE_DOUBLE';
  return doc.toString({ lineWidth: 0 });
}

/**
 * Saves `golden` as `requestId`'s sidecar, atomically: a uniquely named temp file, then a rename
 * over it. Refuses an unsaved request, and a sidecar path that holds a symlink, a folder or
 * anything but a regular file (it is never followed). A failed write removes the temp file and throws.
 */
export async function writeGoldenFile(
  projectDir: string,
  project: Project,
  requestId: string,
  golden: GoldenFile,
): Promise<GoldenWrite> {
  const sidecar = await sidecarOf(projectDir, project, requestId);
  if (sidecar === undefined) return { status: 'refused', reason: 'unsaved' };
  try {
    if (!(await lstat(sidecar.file)).isFile()) return { status: 'refused', reason: 'not-a-file' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = `${sidecar.file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, goldenText(golden), 'utf8');
    await rename(temp, sidecar.file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { status: 'written', file: sidecar.relative };
}
