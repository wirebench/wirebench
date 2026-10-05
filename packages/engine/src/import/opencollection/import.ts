/**
 * Reading an OpenCollection and turning it into Wirebench APIs, variables and scripts. A single
 * document is read here, as a file or as text; the directory form is walked by the desktop main
 * process, which hands over the root's text and a map of its files.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { OpenCollectionError } from '../../errors.js';
import type { MapOpenCollectionOptions, MappedOpenCollection } from './map.js';
import { mapOpenCollection } from './map.js';
import { MAX_OPENCOLLECTION_BYTES } from './model.js';
import { isFolderRoot, parseOpenCollection } from './parse.js';

/** Where a collection comes from: a single document on disk or in memory, or a directory's files. */
export type OpenCollectionSource =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tree';
      readonly rootText: string;
      /** Root-relative POSIX paths to text. */
      readonly files: ReadonlyMap<string, string>;
      /** The root document's own key in `files`, so it is never read as an item. */
      readonly rootKey?: string;
    };

function tooLarge(): OpenCollectionError {
  return new OpenCollectionError(
    'oc-too-large',
    `The OpenCollection is larger than ${MAX_OPENCOLLECTION_BYTES / (1024 * 1024)} MB`,
  );
}

/**
 * The UTF-8 length of `text` in bytes, counted by hand rather than encoded so a long text is never
 * copied. A surrogate pair is four bytes; a lone surrogate is three, the replacement character an
 * encoder writes for it.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Whether texts together are past {@link MAX_OPENCOLLECTION_BYTES} in UTF-8 bytes, the unit a
 * picked file's size is measured in. A UTF-16 unit is one to three bytes, so most texts are settled
 * by their length alone and only the rest are counted.
 */
function pastCap(texts: Iterable<string>): boolean {
  const all = [...texts];
  let units = 0;
  for (const text of all) units += text.length;
  if (units > MAX_OPENCOLLECTION_BYTES) return true;
  if (units * 3 <= MAX_OPENCOLLECTION_BYTES) return false;
  let bytes = 0;
  for (const text of all) {
    bytes += utf8ByteLength(text);
    if (bytes > MAX_OPENCOLLECTION_BYTES) return true;
  }
  return false;
}

/**
 * One OpenCollection document's text from disk, refused past {@link MAX_OPENCOLLECTION_BYTES}
 * rather than read whole.
 *
 * @throws OpenCollectionError `oc-too-large` or `oc-read-failed`
 */
export async function readOpenCollectionFile(path: string): Promise<string> {
  let size: number | undefined;
  try {
    size = (await stat(path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_OPENCOLLECTION_BYTES) throw tooLarge();
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new OpenCollectionError(
      'oc-read-failed',
      `Failed to read OpenCollection file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reads, parses and maps an OpenCollection. A file's body file paths resolve beside it unless
 * `options.rootDir` says otherwise; text has no folder, so they stay relative.
 *
 * @throws OpenCollectionError `oc-too-large`, `oc-read-failed`, the parser's codes,
 *   `oc-folder-root` when a single document with nothing to import is a folder collection's root
 *   (it has no `items`), or `oc-nothing-to-import` when the collection has no request and no
 *   environment.
 */
export async function importOpenCollection(
  source: OpenCollectionSource,
  options: MapOpenCollectionOptions = {},
): Promise<MappedOpenCollection> {
  let mapped: MappedOpenCollection;
  /** A single document's text, so an empty result can be told apart from a folder's root. */
  let single: string | undefined;
  if (source.kind === 'file') {
    const path = resolve(source.path);
    single = await readOpenCollectionFile(path);
    mapped = mapOpenCollection(parseOpenCollection(single), { ...options, rootDir: options.rootDir ?? dirname(path) });
  } else if (source.kind === 'text') {
    if (pastCap([source.text])) throw tooLarge();
    single = source.text;
    mapped = mapOpenCollection(parseOpenCollection(single), options);
  } else {
    if (pastCap([source.rootText, ...source.files.values()])) throw tooLarge();
    mapped = mapOpenCollection(parseOpenCollection(source.rootText, source.files, source.rootKey), options);
  }
  if (mapped.counts.requests === 0 && mapped.variables.environments.length === 0) {
    if (single !== undefined && isFolderRoot(single)) {
      throw new OpenCollectionError(
        'oc-folder-root',
        'This is the root of a folder collection: pick opencollection.yml from its folder; a dropped file is read as a single document.',
      );
    }
    throw new OpenCollectionError(
      'oc-nothing-to-import',
      'The OpenCollection has no requests and no environments to import.',
    );
  }
  return mapped;
}
