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
import { parseOpenCollection } from './parse.js';

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

async function readSource(path: string): Promise<string> {
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
 * @throws OpenCollectionError `oc-too-large`, `oc-read-failed`, the parser's codes, or
 *   `oc-nothing-to-import` when the collection has no request and no environment.
 */
export async function importOpenCollection(
  source: OpenCollectionSource,
  options: MapOpenCollectionOptions = {},
): Promise<MappedOpenCollection> {
  let mapped: MappedOpenCollection;
  if (source.kind === 'file') {
    const path = resolve(source.path);
    const text = await readSource(path);
    mapped = mapOpenCollection(parseOpenCollection(text), { ...options, rootDir: options.rootDir ?? dirname(path) });
  } else if (source.kind === 'text') {
    if (source.text.length > MAX_OPENCOLLECTION_BYTES) throw tooLarge();
    mapped = mapOpenCollection(parseOpenCollection(source.text), options);
  } else {
    let total = source.rootText.length;
    for (const text of source.files.values()) total += text.length;
    if (total > MAX_OPENCOLLECTION_BYTES) throw tooLarge();
    mapped = mapOpenCollection(parseOpenCollection(source.rootText, source.files, source.rootKey), options);
  }
  if (mapped.counts.requests === 0 && mapped.variables.environments.length === 0) {
    throw new OpenCollectionError(
      'oc-nothing-to-import',
      'The OpenCollection has no requests and no environments to import.',
    );
  }
  return mapped;
}
