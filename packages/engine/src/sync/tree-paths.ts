/**
 * The rules a path in a synced workspace tree obeys (server-sync spec §3.2, §6). Wirebench Server
 * checks every path a push names before any git call. The desktop checks every path a snapshot or a
 * change names before it writes to disk. Both call {@link assertTreePath}, so both ends refuse
 * exactly the same paths.
 */
import { WirebenchError } from '../errors.js';
import { WORKSPACE_LOCAL_FILE } from '../workspace/local-state.js';
import {
  GIT_ATTRIBUTES_FILE,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
} from '../workspace/paths.js';
import { WORKSPACE_SHARE_FILE } from '../workspace/share.js';

/** Everything that makes up a workspace tree, in the order a share moves them (formerly private to the desktop's workspace-share.ts). */
export const TREE_ITEMS = [
  WORKSPACE_MANIFEST,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_PROJECTS_DIR,
  GIT_ATTRIBUTES_FILE,
] as const;

/** The tree items that are single files. The other two are directories, so a path names a file below them. */
const FILE_ITEMS: ReadonlySet<string> = new Set([WORKSPACE_MANIFEST, GIT_ATTRIBUTES_FILE]);

/** Longest tree path the sync accepts, in characters (§3.2). */
export const MAX_TREE_PATH_LENGTH = 512;

/**
 * Machine-local names that never travel: 'share.yaml', 'local.yaml' and the 'unsaved' directory
 * (the desktop's `UNSAVED_DIR`). They live beside the tree in a workspace's app-data folder, and a
 * snapshot or a commit that carried one would leak one machine's state (and a secret-bearing
 * recovery record) to every member.
 */
export const MACHINE_LOCAL_PATHS: readonly string[] = [WORKSPACE_SHARE_FILE, WORKSPACE_LOCAL_FILE, 'unsaved'];

/** C0 controls and DEL: git's `-z` output and `update-index` input cannot carry them faithfully. */
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
/** A POSIX root, or a Windows drive. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:)/;
/**
 * `.git` in any case, with the trailing dots or spaces Windows ignores, its 8.3 short name, and any
 * of those followed by an NTFS alternate-data-stream suffix (`:$INDEX_ALLOCATION`, a bare `:`, or
 * `git~1:x`) — every spelling git itself refuses in a tree under `core.protectNTFS`.
 */
const GIT_SEGMENT = /^(?:\.git|git~\d+)[. ]*(?::.*)?$/i;
/**
 * A segment Windows cannot hold: a reserved device name, with or without an extension (and with the
 * spaces Windows ignores before it); a trailing dot or space, which Windows drops; or a character
 * Windows refuses in a name. A Mac or Linux editor can create one, and once pushed it would stop
 * every Windows teammate from opening the workspace, so both ends refuse it (`assertPathSegment`'s
 * rules for the name part).
 */
const WINDOWS_UNSAFE_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]) *(?:\.|$)|[. ]$|[<>:"|?*]/i;

/** Why a path was refused; `details.reason` of the error. */
type Refusal =
  | 'empty'
  | 'too-long'
  | 'control-character'
  | 'backslash'
  | 'absolute'
  | 'empty-segment'
  | 'dot-segment'
  | 'git-segment'
  | 'windows-unsafe'
  | 'machine-local'
  | 'not-in-tree'
  | 'not-a-file';

function refusal(path: string): Refusal | undefined {
  if (path.length === 0) {
    return 'empty';
  }
  if (path.length > MAX_TREE_PATH_LENGTH) {
    return 'too-long';
  }
  if (CONTROL_CHARACTER.test(path)) {
    return 'control-character';
  }
  if (path.includes('\\')) {
    return 'backslash';
  }
  if (ABSOLUTE.test(path)) {
    return 'absolute';
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return 'empty-segment';
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'dot-segment';
  }
  if (segments.some((segment) => GIT_SEGMENT.test(segment))) {
    return 'git-segment';
  }
  if (segments.some((segment) => WINDOWS_UNSAFE_SEGMENT.test(segment))) {
    return 'windows-unsafe';
  }
  const first = segments[0] ?? '';
  if (MACHINE_LOCAL_PATHS.includes(first)) {
    return 'machine-local';
  }
  if (!(TREE_ITEMS as readonly string[]).includes(first)) {
    return 'not-in-tree';
  }
  if (FILE_ITEMS.has(first) !== (segments.length === 1)) {
    return 'not-a-file';
  }
  return undefined;
}

/**
 * Returns `path` when it is a relative, normalised, forward-slash tree path of at most 512
 * characters: no '..', '.' or empty segment, no '.git' segment (in any spelling git refuses), no
 * segment Windows cannot hold (a device name, a trailing dot or space, one of `<>:"|?*`), no
 * backslash or control character, not absolute, not machine-local, whose first segment is one of
 * TREE_ITEMS, and which names a file (`workspace.yaml` and `.gitattributes` stand alone; the two
 * directories need something below them).
 *
 * @throws WirebenchError 'sync-path-refused' otherwise, with `details.reason` naming the rule and
 * `details.path` the path, cut to {@link MAX_TREE_PATH_LENGTH} characters.
 */
export function assertTreePath(path: string): string {
  const reason = refusal(path);
  if (reason !== undefined) {
    const shown = path.slice(0, MAX_TREE_PATH_LENGTH);
    throw new WirebenchError(
      'sync-path-refused',
      `${JSON.stringify(shown.slice(0, 120))} cannot be part of a shared workspace.`,
      { details: { path: shown, reason } },
    );
  }
  return path;
}

/** Whether {@link assertTreePath} would accept `path`. */
export function isTreePath(path: string): boolean {
  return refusal(path) === undefined;
}
