/**
 * Reading a folder (v3) collection from disk for the hosts: the CLI, and the desktop once it has
 * checked the picked path. The walk follows no symbolic link — a file or a folder — keeps every
 * entry inside the root's real path, opens each file with no-follow, and stops at
 * {@link COLLECTION_V3_FOLDER_LIMITS}. Only `*.yaml`, `*.yml` and `*.js` files are read; `.git` and
 * `node_modules` are skipped.
 */

import { lstat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { PostmanError } from '../../errors.js';
import type { ImportFolderErrorCode, ImportFolderLimits } from '../read-folder.js';
import { IMPORT_FOLDER_LIMITS, readImportFolder } from '../read-folder.js';
import type { MapCollectionV3Options, MappedCollectionV3 } from './map.js';
import { mapCollectionV3 } from './map.js';
import { readCollectionV3 } from './parse.js';

/** The limits of one folder walk. */
export type CollectionV3FolderLimits = ImportFolderLimits;

export const COLLECTION_V3_FOLDER_LIMITS: CollectionV3FolderLimits = IMPORT_FOLDER_LIMITS;

const READ_FILE = /\.(?:ya?ml|js)$/i;
const DEFINITION_FILE = /^definition\.ya?ml$/i;
const REQUEST_FILE = /\.request\.ya?ml$/i;

/** The Postman error codes of the shared walk's refusals. */
const WALK_CODES: Readonly<Record<ImportFolderErrorCode, string>> = {
  'not-a-folder': 'postman-v3-not-a-folder',
  'too-many-files': 'postman-v3-too-many-files',
  'too-deep': 'postman-v3-too-deep',
  'too-large': 'postman-too-large',
  'read-failed': 'postman-read-failed',
};

function readFailed(path: string, error: unknown): PostmanError {
  return new PostmanError(
    'postman-read-failed',
    `Failed to read the collection at "${path}": ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/**
 * The folder a picked path stands for: a folder is itself; a collection's
 * `.resources/definition.yaml` is the folder above `.resources`. A request file alone is refused:
 * the collection is its folder.
 *
 * @throws PostmanError `postman-v3-pick-folder` for a request file, `postman-v3-not-a-collection`
 *   for any other file, `postman-read-failed` when the path cannot be looked at
 */
export async function collectionV3Root(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw readFailed(path, error);
  }
  if (info.isDirectory()) return path;
  const name = basename(path);
  if (DEFINITION_FILE.test(name) && basename(dirname(path)) === '.resources') return dirname(dirname(path));
  if (REQUEST_FILE.test(name)) {
    throw new PostmanError(
      'postman-v3-pick-folder',
      'This is one request of a folder collection: pick the collection folder (or its .resources/definition.yaml) instead.',
    );
  }
  throw new PostmanError(
    'postman-v3-not-a-collection',
    'Pick a folder collection: its folder, or its .resources/definition.yaml.',
  );
}

/**
 * Every `*.yaml`, `*.yml` and `*.js` under `root`, keyed by POSIX path relative to it. `root` must be
 * a folder and not a link. `limits` exists for tests.
 *
 * @throws PostmanError `postman-v3-not-a-folder`, `postman-v3-too-many-files` (files or entries),
 *   `postman-v3-too-deep`, `postman-too-large`, `postman-read-failed`
 */
export async function readCollectionV3Folder(
  root: string,
  limits: CollectionV3FolderLimits = COLLECTION_V3_FOLDER_LIMITS,
): Promise<Map<string, string>> {
  return readImportFolder(root, {
    readFile: (name) => READ_FILE.test(name),
    limits,
    error: (code, message, cause) =>
      new PostmanError(WALK_CODES[code], message, cause !== undefined ? { cause } : undefined),
  });
}

/**
 * Reads and maps the folder collection a picked path stands for (see {@link collectionV3Root}).
 * The picked folder's name names a collection that has no definition.
 */
export async function importCollectionV3Folder(
  path: string,
  options: MapCollectionV3Options = {},
): Promise<MappedCollectionV3> {
  const root = await collectionV3Root(path);
  const files = await readCollectionV3Folder(root);
  return mapCollectionV3(readCollectionV3(files, basename(root)), options);
}
