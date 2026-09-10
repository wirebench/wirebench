/**
 * "Does this path stay inside that folder?", answered against the real file system.
 *
 * Every main-process feature that turns renderer-supplied text into a file path — the Dump
 * File property, inline-file resolution, opening an attachment — needs the same answer, and
 * needs it to survive a symlink planted anywhere in the existing part of the path. Keeping
 * one implementation means a fix to the symlink handling fixes all of them at once.
 */

import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';

/**
 * `path`, with `realpath` resolved through whatever prefix of it already exists on disk —
 * e.g. for `/tmp/proj/dumps/out.xml` where only `/tmp/proj` exists, this is `realpath('/tmp/proj')`
 * joined back with the still-nonexistent `dumps/out.xml` tail. Neither `/tmp/proj` nor the tail
 * is created; this only computes the path a later `mkdir`+`writeFile` would actually land at,
 * so a symlink anywhere in the existing prefix cannot be used to escape a containment check.
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
    return path;
  }
}

/** True when `candidate` is `root` itself or sits below it. Both must already be real paths. */
export function isInsideReal(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * True when `candidate` resolves inside at least one of `roots`, comparing real paths so a
 * symlink cannot be used to point out of them.
 */
export async function isInsideAny(roots: readonly string[], candidate: string): Promise<boolean> {
  const candidateReal = await realpathOfPrefix(candidate);
  const rootReals = await Promise.all(roots.map((root) => realpathOfPrefix(root)));
  return rootReals.some((root) => isInsideReal(root, candidateReal));
}
