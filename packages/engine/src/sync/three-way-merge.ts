/**
 * A per-file three-way merge shared by the desktop's unsaved-changes recovery and, later, the sync
 * backends (a fake one in the desktop's tests today, Wirebench Server's tomorrow). It lives in the
 * engine so both run the same code — the point of ADR-0008's "one repository, two transports".
 */
import { MANIFEST_PATH } from '../project/serialize.js';
import type { ProjectFiles } from '../project/serialize.js';

/** The outcome of laying one side's files back over the other's. */
export interface FileMerge {
  /** The files the merged tree should be read from. */
  readonly files: ProjectFiles;
  /** Changed on both sides; the `unsaved` (mine) version was kept — or, for a deletion on the
   * `unsaved` side of a file that changed on `disk`, the disk version was. */
  readonly conflicts: readonly string[];
  /** Changed on the `unsaved` side but deleted on `disk`; the change was dropped. */
  readonly dropped: readonly string[];
  /** Whether the merged files differ from `disk` at all. */
  readonly changed: boolean;
}

/**
 * The manifest records which save wrote it (`writtenBy: wirebench (manual)`), so two otherwise
 * identical manifests differ after every save. That line is not a change anyone made.
 */
function comparable(path: string, content: string | undefined): string | undefined {
  if (content === undefined || path !== MANIFEST_PATH) {
    return content;
  }
  return content
    .split('\n')
    .filter((line) => !/^writtenBy:/.test(line))
    .join('\n');
}

function same(path: string, a: string | undefined, b: string | undefined): boolean {
  return comparable(path, a) === comparable(path, b);
}

/**
 * Three-way merge, one file at a time, of the `baseline` (B) both sides started from, the files
 * on `disk` (D, "theirs") and the `unsaved` files (U, "mine"):
 *
 * - U = B → D (only disk changed, or nothing did);
 * - D = B → U (only the unsaved side changed — including an unsaved deletion);
 * - both changed:
 *   - D = U → U (the same change on both sides);
 *   - deleted on disk → dropped (the file, e.g. a request, no longer exists);
 *   - deleted in the unsaved record → D, flagged (a change on disk beats an unsaved deletion);
 *   - otherwise → U, flagged (unsaved changes are restored on top).
 */
export function mergeFiles(baseline: ProjectFiles, disk: ProjectFiles, unsaved: ProjectFiles): FileMerge {
  const files = new Map<string, string>();
  const conflicts: string[] = [];
  const dropped: string[] = [];
  const paths = [...new Set([...baseline.keys(), ...disk.keys(), ...unsaved.keys()])].sort();
  for (const path of paths) {
    const b = baseline.get(path);
    const d = disk.get(path);
    const u = unsaved.get(path);
    let take: string | undefined;
    if (same(path, u, b)) {
      take = d;
    } else if (same(path, d, b)) {
      take = u;
    } else if (same(path, d, u)) {
      take = u;
    } else if (d === undefined) {
      dropped.push(path);
      take = undefined;
    } else if (u === undefined) {
      conflicts.push(path);
      take = d;
    } else {
      conflicts.push(path);
      take = u;
    }
    if (take !== undefined) {
      files.set(path, take);
    }
  }
  const changed = [...new Set([...files.keys(), ...disk.keys()])].some(
    (path) => !same(path, files.get(path), disk.get(path)),
  );
  return { files, conflicts, dropped, changed };
}
