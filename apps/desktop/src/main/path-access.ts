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

import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { ImportSourceWire } from '../shared/wire-types.js';
import { isInsideAny, isInsideReal } from './path-containment.js';
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

/**
 * The import-side use of {@link allowsReadPath}, shared by `definition.import`,
 * `project.addInterface` and `api.importOpenApi`: a `file` source is a read at a renderer-named
 * path (WSDL or OpenAPI — the rule is about the path, not the format), so it is allowed
 * only inside one of `roots` (every open project folder) or when the user drove the "Browse…"
 * Open dialog to it this session. Nothing else — not a drag-and-drop, not a typed-in path — is
 * evidence; the import dialog's drop zone therefore reads the file in the renderer and imports
 * it as `text`.
 *
 * @returns the source, with a `file` path resolved to the absolute path that was checked
 * @throws WirebenchError `import-path-refused` when the path is neither contained nor picked
 */
export async function checkedImportSource(
  roots: readonly string[],
  picks: ReadPicks | undefined,
  source: ImportSourceWire,
): Promise<ImportSourceWire> {
  if (source.kind !== 'file') {
    return source;
  }
  const resolved = resolve(source.path);
  if (!(await allowsReadPath(roots, picks, resolved))) {
    throw new WirebenchError(
      'import-path-refused',
      `Wirebench will not read "${source.path}": use Browse… to pick a definition outside the project folder`,
      { details: { path: source.path } },
    );
  }
  return { kind: 'file', path: resolved };
}

/** Whether `rel`, a `path.relative` result, names something strictly below the folder it was taken from. */
function isBelow(rel: string): boolean {
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Files beside a file the user picked (or one inside a project folder), read only because that
 * file was: exact names, no links, nothing outside its folder (ADR-0005).
 *
 * The anchor must pass {@link allowsReadPath} itself. Each name is resolved against the anchor's
 * folder and refused when it leaves that folder, is a symbolic link, or is reached through one; a
 * name with nothing at it, or a folder at it, is dropped rather than refused, since a companion is
 * optional.
 *
 * @returns the absolute paths of the companions that exist, in the order asked for
 * @throws WirebenchError `import-path-refused` when the anchor is not readable or a name is refused
 */
export async function checkedCompanionPaths(
  roots: readonly string[],
  picks: ReadPicks | undefined,
  anchorFile: string,
  names: readonly string[],
): Promise<string[]> {
  const anchor = resolve(anchorFile);
  if (!(await allowsReadPath(roots, picks, anchor))) {
    throw new WirebenchError(
      'import-path-refused',
      `Wirebench will not read beside "${anchorFile}": use Browse… to pick it`,
      { details: { path: anchorFile } },
    );
  }
  const base = dirname(anchor);
  const refuse = (name: string, why: string): never => {
    throw new WirebenchError('import-path-refused', `"${name}" ${why}`, { details: { path: name } });
  };
  const allowed: string[] = [];
  for (const name of names) {
    const target = resolve(base, name);
    if (!isBelow(relative(base, target))) {
      refuse(name, `is outside the folder of "${anchorFile}"`);
    }
    let info;
    try {
      info = await lstat(target);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      refuse(name, 'is a symbolic link and is not followed');
    }
    // A linked folder between the anchor's folder and the file would leave it without the leaf being a link.
    let baseReal: string;
    let parentReal: string;
    try {
      [baseReal, parentReal] = await Promise.all([realpath(base), realpath(dirname(target))]);
    } catch (error) {
      // The folder went away since the `lstat`: the companion is as missing as one never there.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new WirebenchError('import-path-refused', `"${name}" could not be checked and was not read`, {
        details: { path: name },
        cause: error,
      });
    }
    if (!isInsideReal(baseReal, parentReal)) {
      refuse(name, `is reached through a symbolic link and is not followed`);
    }
    if (info.isFile()) allowed.push(target);
  }
  return allowed;
}
