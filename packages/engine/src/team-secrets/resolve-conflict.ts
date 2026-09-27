/**
 * §3.5: a vault entry is a whole-file value. Of two concurrent versions the later `updatedAt` wins, then
 * the lower `updatedBy`; a side without the file (deleted, or unreadable) loses to one that has it (plan
 * decision 8). Both missing: theirs.
 */
import type { VaultEntryFile } from './schema.js';

export function vaultConflictWinner(
  mine: VaultEntryFile | undefined,
  theirs: VaultEntryFile | undefined,
): 'mine' | 'theirs' {
  if (mine === undefined) {
    return 'theirs';
  }
  if (theirs === undefined) {
    return 'mine';
  }
  const mineAt = Date.parse(mine.updatedAt);
  const theirsAt = Date.parse(theirs.updatedAt);
  if (mineAt !== theirsAt) {
    return mineAt > theirsAt ? 'mine' : 'theirs';
  }
  return mine.updatedBy < theirs.updatedBy ? 'mine' : 'theirs';
}
