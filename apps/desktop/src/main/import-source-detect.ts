/**
 * What a picked import file or folder is, decided in main: a picked file's content never reaches the
 * renderer, so only here can the content rules (a renamed export, a folder's marker files) run.
 *
 * Reads follow the import rule: the path must be picked this session or inside an open project
 * ({@link checkedImportSource}), no symbolic link is followed, and a file is read up to a cap.
 */

import { lstat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import { detectImportFolder, detectImportFormat, type DetectedImportFormat } from '@wirebench/engine/detect';
import type { ReadPicks } from './dialog-picks.js';
import { checkedImportSource, readNoFollow } from './path-access.js';

/** The most of a picked file that is read to tell what it is. */
const MAX_DETECT_FILE_BYTES = 50 * 1024 * 1024;

/** Thunder Client's saved collections live in `collections/` as `tc_col_*.json`. */
const THUNDER_COLLECTION_FILE = /^tc_col_.*\.json$/i;

const THUNDER_FOLDER_NAME = 'thunder-tests';

/** The direct children of `dir`, a folder's name with a trailing `/`. */
async function childNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
}

/**
 * @param roots open project folders, readable by definition
 * @param picks the session's dialog memory
 * @param request the path the renderer names, and whether it is a folder
 * @throws WirebenchError `import-path-refused` for a path that is neither picked nor inside a project
 */
export async function detectImportSource(
  roots: readonly string[],
  picks: ReadPicks | undefined,
  request: { readonly path: string; readonly folder: boolean },
): Promise<DetectedImportFormat> {
  const checked = await checkedImportSource(roots, picks, { kind: 'file', path: request.path });
  if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a path');
  const path = checked.path;
  if (!request.folder) {
    const bytes = await readNoFollow(
      path,
      MAX_DETECT_FILE_BYTES,
      () => new WirebenchError('import-too-large', `${basename(path)} is larger than 50 MB`, { details: { path } }),
    );
    if (bytes === undefined) {
      throw new WirebenchError('import-path-refused', `"${basename(path)}" is not a regular file and was not read`, {
        details: { path },
      });
    }
    return detectImportFormat({ text: bytes.toString('utf8'), filename: basename(path) });
  }
  if ((await lstat(path)).isSymbolicLink()) {
    throw new WirebenchError('import-path-refused', `"${basename(path)}" is a symbolic link and is not followed`, {
      details: { path },
    });
  }
  const children = await childNames(path);
  const found = detectImportFolder(children);
  if (found.confidence !== 'probable') return found;
  // Nothing in the folder named a format. Two Thunder Client layouts need a look one level down.
  const thunder = detectImportFolder(['thunderEnvironment.json']);
  if (basename(path).toLowerCase() === THUNDER_FOLDER_NAME) return thunder;
  if (children.includes('collections/')) {
    const inside = await childNames(join(path, 'collections')).catch(() => []);
    if (inside.some((name) => THUNDER_COLLECTION_FILE.test(name))) return thunder;
  }
  return found;
}
