/**
 * Reading an Insomnia export from a file or text and mapping it. File access stays here, out of
 * the pure reader and mapper.
 */

import { readFile, stat } from 'node:fs/promises';
import { InsomniaError } from '../../errors.js';
import type { MappedClientImport } from '../client-import.js';
import type { MapInsomniaOptions } from './map.js';
import { mapInsomnia } from './map.js';
import { MAX_INSOMNIA_BYTES } from './model.js';
import { parseInsomnia } from './parse.js';

export type InsomniaSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string };

/**
 * An export's text from disk, refused past 50 MB rather than read whole.
 *
 * @throws InsomniaError `insomnia-too-large` or `insomnia-read-failed`
 */
export async function readInsomniaFile(path: string): Promise<string> {
  let size: number | undefined;
  try {
    size = (await stat(path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_INSOMNIA_BYTES) {
    throw new InsomniaError(
      'insomnia-too-large',
      `The Insomnia export is larger than ${MAX_INSOMNIA_BYTES / (1024 * 1024)} MB`,
    );
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new InsomniaError(
      'insomnia-read-failed',
      `Failed to read the Insomnia export "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reads, parses and maps an Insomnia export.
 *
 * @throws InsomniaError the reader's and the mapper's codes, and `insomnia-read-failed`
 */
export async function importInsomnia(
  source: InsomniaSource,
  options: MapInsomniaOptions = {},
): Promise<MappedClientImport> {
  const text = source.kind === 'file' ? await readInsomniaFile(source.path) : source.text;
  return mapInsomnia(parseInsomnia(text), options);
}
