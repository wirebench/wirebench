/**
 * Reading an Insomnia export from a file or text and mapping it. File access stays here, so the
 * reader and mapper stay pure.
 */

import { InsomniaError, OpenCollectionError } from '../../errors.js';
import type { MappedClientImport } from '../client-import.js';
import { readOpenCollectionFile } from '../opencollection/import.js';
import type { MapInsomniaOptions } from './map.js';
import { mapInsomnia } from './map.js';
import { MAX_INSOMNIA_BYTES } from './model.js';
import { parseInsomnia } from './parse.js';

export type InsomniaSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string };

/** The file's text, read with the importers' size-capped reader; its errors become Insomnia's. */
async function readInsomniaFile(path: string): Promise<string> {
  try {
    return await readOpenCollectionFile(path);
  } catch (error) {
    if (error instanceof OpenCollectionError && error.code === 'oc-too-large') {
      throw new InsomniaError(
        'insomnia-too-large',
        `The Insomnia export is larger than ${MAX_INSOMNIA_BYTES / (1024 * 1024)} MB.`,
        { cause: error },
      );
    }
    const cause = error instanceof OpenCollectionError && error.cause !== undefined ? error.cause : error;
    throw new InsomniaError(
      'insomnia-read-failed',
      `Failed to read the Insomnia export "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause: error },
    );
  }
}

/**
 * Reads, parses and maps an Insomnia export.
 *
 * @throws InsomniaError `insomnia-too-large`, `insomnia-read-failed`, or the reader's codes
 */
export async function importInsomnia(
  source: InsomniaSource,
  options: MapInsomniaOptions = {},
): Promise<MappedClientImport> {
  const text = source.kind === 'file' ? await readInsomniaFile(source.path) : source.text;
  return mapInsomnia(parseInsomnia(text), options);
}
