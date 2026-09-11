/**
 * "Does this path stay inside that folder?", answered against the real file system.
 *
 * The engine needs the same answer the desktop app's `main/path-containment.ts` gives, for a
 * different reason: a WSDL fetched from anywhere may reference further documents by `file:`
 * URL, and those references must not be able to walk out of the root document's own folder.
 * Main's copy stays where it is — it guards renderer-named paths and is reachable from
 * Electron-only code — but the rule itself is identical, so a fix here should be mirrored
 * there (and vice versa).
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';

/**
 * `path`, with `realpath` resolved through whatever prefix of it already exists on disk, the
 * still-missing tail joined back on. Nothing is created; this only computes the path a later
 * read would actually land at, so a symlink anywhere in the existing prefix cannot be used to
 * escape a containment check.
 *
 * @param path the absolute path to resolve
 * @returns the real path of the existing prefix joined with the unresolved tail
 */
export async function realpathOfPrefix(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      // Hit the filesystem root without finding anything that exists; nothing to resolve.
      return path;
    }
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    const real = await realpath(current);
    return tail.length === 0 ? real : join(real, ...tail);
  } catch {
    /* v8 ignore next 2 -- realpath of an existsSync-confirmed path only fails on a race */
    return path;
  }
}

/**
 * True when `candidate` is `root` itself or sits below it. Both must already be real paths.
 *
 * @param root the containing folder, as a real path
 * @param candidate the path to test, as a real path
 */
export function isInsideReal(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * True when `candidate` resolves inside `root`, comparing real paths so a symlink cannot be
 * used to point out of it.
 *
 * @param root the containing folder
 * @param candidate the path to test
 */
export async function isInsideRealDir(root: string, candidate: string): Promise<boolean> {
  const [rootReal, candidateReal] = await Promise.all([realpathOfPrefix(root), realpathOfPrefix(candidate)]);
  return isInsideReal(rootReal, candidateReal);
}
