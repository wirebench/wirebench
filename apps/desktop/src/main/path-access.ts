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

import { resolve } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { ImportSourceWire } from '../shared/wire-types.js';
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

/**
 * The import-side use of {@link allowsReadPath}, shared by `definition.import` and
 * `project.addInterface`: a `file` source is a read at a renderer-named path, so it is allowed
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
      `Wirebench will not read "${source.path}": use Browse… to pick a WSDL outside the project folder`,
      { details: { path: source.path } },
    );
  }
  return { kind: 'file', path: resolved };
}
