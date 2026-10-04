/**
 * Which files of a request tree a save manages, and so may delete when it no longer writes them:
 * the part of `save.ts` that every protocol keeping its requests under `apis/<slug>/requests/`
 * shares, and that the webhook collection's tree uses too.
 *
 * One lister claims every sibling convention (`.body.<ext>`, `.msg-<slug>.<ext>`, the script
 * files) whatever the API's protocol, exactly as it did when `save.ts` walked `apis/` itself.
 */

import { join } from 'node:path';
import { isScriptFileOf } from '../script/model.js';
import type { FsLike } from './fs.js';
import { readFileIfExists, readdirIfExists } from './fs.js';
import { API_FILE, APIS_DIR, EXAMPLES_SUFFIX, FOLDER_FILE, REQUEST_SUFFIX, REQUESTS_DIR } from './paths.js';

/** The absolute path of a `/`-separated path relative to the project root. */
export function toAbsolute(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

/**
 * True when `name` is a WebSocket request's saved-message sibling for `requestSlug`:
 * `<requestSlug>.msg-<message-slug>.<ext>`, where `<ext>` is one `[A-Za-z0-9]+` run at the very
 * end. Matched by trying the known `requestSlug` as a literal prefix — never by a greedy regex
 * capture across the whole name — so a request slug that itself contains a dot or the literal text
 * `.msg-` cannot be mis-split from the message slug that follows it.
 */
export function isWsMessageSibling(name: string, requestSlug: string): boolean {
  const prefix = `${requestSlug}.msg-`;
  if (!name.startsWith(prefix)) {
    return false;
  }
  const rest = name.slice(prefix.length);
  const dot = rest.lastIndexOf('.');
  // dot > 0 requires a non-empty message slug before the extension.
  return dot > 0 && /^[A-Za-z0-9]+$/.test(rest.slice(dot + 1));
}

/**
 * True when the directory `name` inside `dir` is a request's `<slug>.examples/`: named after a
 * request slug present in `dir`, and holding no `folder.yaml` and no `*.request.yaml`. A slug may
 * contain a dot and a folder's slug is uniqued apart from its requests', so a real folder can carry
 * that name; one that holds a folder file or a request is walked as the folder it is.
 */
export async function isExamplesDir(
  fs: FsLike,
  root: string,
  dir: string,
  name: string,
  requestSlugs: ReadonlySet<string>,
): Promise<boolean> {
  if (!name.endsWith(EXAMPLES_SUFFIX) || !requestSlugs.has(name.slice(0, -EXAMPLES_SUFFIX.length))) {
    return false;
  }
  const entries = await readdirIfExists(fs, toAbsolute(root, `${dir}/${name}`));
  return !entries.some((entry) => entry.isFile && (entry.name === FOLDER_FILE || entry.name.endsWith(REQUEST_SUFFIX)));
}

/**
 * Lists the managed files inside one directory of an API's request tree: its `folder.yaml`, every
 * `*.request.yaml`, and two conventions of per-request sibling file, each claimed only when it
 * belongs to a request slug actually present in this directory:
 *
 * - `<slug>.body.<ext>` — a REST raw body or a gRPC message, one file for the whole request.
 * - `<slug>.msg-<message-slug>.<ext>` — one WebSocket saved message, one file per message
 *   ({@link isWsMessageSibling}).
 * - `<slug>.pre.ts`, `<slug>.post.ts`, `<slug>.pre.js`, `<slug>.post.js` — a request's scripts (#63).
 * - every `<id>.body.<ext>` in `<slug>.examples/` — a REST request's response examples (#64); the
 *   directory is the request's, not a folder, so it is not walked as one ({@link isExamplesDir}).
 *
 * Claiming only a sibling of a *known* request slug (rather than every file matching either
 * pattern) means a hand-placed file — notes, a `.body.json` or `.msg-x.txt` with no matching
 * request — is foreign and never a deletion candidate, exactly as in an operation folder.
 */
export async function listApiTreeFiles(fs: FsLike, root: string, dir: string): Promise<string[]> {
  const managed: string[] = [];
  const entries = await readdirIfExists(fs, toAbsolute(root, dir));
  const requestSlugs = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile) {
      continue;
    }
    if (entry.name === FOLDER_FILE) {
      managed.push(`${dir}/${entry.name}`);
      continue;
    }
    if (entry.name.endsWith(REQUEST_SUFFIX)) {
      requestSlugs.add(entry.name.slice(0, -REQUEST_SUFFIX.length));
      managed.push(`${dir}/${entry.name}`);
    }
  }
  for (const entry of entries) {
    if (!entry.isFile) {
      continue;
    }
    const body = /^(.*)\.body\.[A-Za-z0-9]+$/.exec(entry.name);
    if (body !== null && requestSlugs.has(body[1]!)) {
      managed.push(`${dir}/${entry.name}`);
      continue;
    }
    for (const slug of requestSlugs) {
      if (isWsMessageSibling(entry.name, slug) || isScriptFileOf(entry.name, slug)) {
        managed.push(`${dir}/${entry.name}`);
        break;
      }
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    if (await isExamplesDir(fs, root, dir, entry.name, requestSlugs)) {
      managed.push(...(await listExampleFiles(fs, root, `${dir}/${entry.name}`)));
      continue;
    }
    managed.push(...(await listApiTreeFiles(fs, root, `${dir}/${entry.name}`)));
  }
  return managed;
}

/** The example body files (`<id>.body.<ext>`) of one `<slug>.examples/`; anything else in it is foreign. */
async function listExampleFiles(fs: FsLike, root: string, dir: string): Promise<string[]> {
  const entries = await readdirIfExists(fs, toAbsolute(root, dir));
  return entries
    .filter((entry) => entry.isFile && /^.+\.body\.[A-Za-z0-9]+$/.test(entry.name))
    .map((entry) => `${dir}/${entry.name}`);
}

/** The managed files of one `apis/<slug>/`: its `api.yaml` when it is there, and its request tree. */
export async function apiManagedFiles(fs: FsLike, root: string, slug: string): Promise<string[]> {
  const base = `${APIS_DIR}/${slug}`;
  const managed: string[] = [];
  if ((await readFileIfExists(fs, toAbsolute(root, `${base}/${API_FILE}`))) !== undefined) {
    managed.push(`${base}/${API_FILE}`);
  }
  managed.push(...(await listApiTreeFiles(fs, root, `${base}/${REQUESTS_DIR}`)));
  return managed;
}
