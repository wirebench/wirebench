/**
 * The one predicate every main-process feature asks before turning renderer-supplied text into
 * a file *read*: "is this path inside a folder we own, or did the user drive an OS dialog to it
 * this session?".
 *
 * Attachments asked it first (`ProjectHost.allowsAttachmentPath`), keystores ask it now, and
 * anything that reads a user-named file next will ask it too. Keeping the two halves of the
 * answer — containment (`path-containment.ts`) and dialog evidence (`dialog-picks.ts`) — joined
 * here means a fix to either reaches every caller at once.
 */

import { isInsideAny } from './path-containment.js';
import type { ReadPicks } from './dialog-picks.js';

/**
 * Whether `resolved` may be read.
 *
 * @param roots folders whose contents are readable by definition (the project folder, its caches)
 * @param picks the session's dialog memory, or `undefined` when nothing was ever picked
 * @param resolved the absolute path to check; symlinks are resolved before comparing
 * @returns `true` when the path is contained in one of `roots` or was picked this session
 */
export async function allowsReadPath(
  roots: readonly string[],
  picks: ReadPicks | undefined,
  resolved: string,
): Promise<boolean> {
  if (picks?.hasRead(resolved) === true) {
    return true;
  }
  return isInsideAny(roots, resolved);
}
