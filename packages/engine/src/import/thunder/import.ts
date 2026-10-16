/**
 * Reading a Thunder Client export or `thunder-tests` folder and mapping it. File access stays here,
 * out of the pure reader and mapper.
 */

import { readFile, stat } from 'node:fs/promises';
import { ThunderError } from '../../errors.js';
import type { MappedClientImport } from '../client-import.js';
import type { ImportFolderErrorCode } from '../read-folder.js';
import { readImportFolder } from '../read-folder.js';
import type { MapThunderOptions } from './convert.js';
import { mapThunderClient } from './convert.js';
import { MAX_THUNDER_BYTES } from './model.js';
import { parseThunderExport, parseThunderFolder } from './parse.js';

export type ThunderSource =
  | { readonly kind: 'folder'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'text'; readonly text: string };

const WALK_CODES: Readonly<Record<ImportFolderErrorCode, string>> = {
  'not-a-folder': 'thunder-not-a-folder',
  'too-many-files': 'thunder-too-many-files',
  'too-deep': 'thunder-too-deep',
  'too-large': 'thunder-too-large',
  'read-failed': 'thunder-read-failed',
};

/**
 * Every `*.json` file under a `thunder-tests` folder by root-relative POSIX path; the `_db-backup*`
 * folders a database upgrade leaves behind are skipped.
 *
 * @throws ThunderError the walk's codes, as `thunder-*`
 */
export async function readThunderFolder(root: string): Promise<Map<string, string>> {
  return readImportFolder(root, {
    readFile: (name) => name.toLowerCase().endsWith('.json'),
    skipFolder: (rel) => rel.split('/').some((segment) => segment.startsWith('_db-backup')),
    error: (code, message, cause) =>
      new ThunderError(WALK_CODES[code], message, cause !== undefined ? { cause } : undefined),
  });
}

async function readExportFile(path: string): Promise<string> {
  let size: number | undefined;
  try {
    size = (await stat(path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_THUNDER_BYTES) {
    throw new ThunderError('thunder-too-large', 'The Thunder Client export is larger than 50 MB');
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new ThunderError(
      'thunder-read-failed',
      `Failed to read the Thunder Client export "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reads and maps a Thunder Client export file or text, or a `thunder-tests` folder.
 *
 * @throws ThunderError the walk's, reader's and mapper's codes
 */
export async function importThunderClient(
  source: ThunderSource,
  options: MapThunderOptions = {},
): Promise<MappedClientImport> {
  if (source.kind === 'folder')
    return mapThunderClient(parseThunderFolder(await readThunderFolder(source.path)), options);
  const text = source.kind === 'file' ? await readExportFile(source.path) : source.text;
  return mapThunderClient(parseThunderExport(text), options);
}
