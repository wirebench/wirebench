/**
 * Reading a HAR capture from a file or text and turning it into REST APIs.
 */

import { readFile, stat } from 'node:fs/promises';
import { HarError } from '../../errors.js';
import type { MapHarOptions, MappedHar } from './map.js';
import { mapHar } from './map.js';
import { MAX_HAR_INPUT_BYTES } from './model.js';
import { parseHarText } from './parse.js';

/** Where a HAR capture comes from: a file on disk or text already held in memory. */
export type HarSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string };

function tooLarge(): HarError {
  return new HarError('har-too-large', `The HAR file is larger than ${MAX_HAR_INPUT_BYTES / (1024 * 1024)} MB`);
}

async function readHarSource(source: HarSource): Promise<string> {
  if (source.kind === 'text') {
    if (source.text.length > MAX_HAR_INPUT_BYTES) throw tooLarge();
    return source.text;
  }
  let size: number | undefined;
  try {
    size = (await stat(source.path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_HAR_INPUT_BYTES) throw tooLarge();
  try {
    return await readFile(source.path, 'utf8');
  } catch (error) {
    throw new HarError(
      'har-read-failed',
      `Failed to read HAR file "${source.path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Reads, parses and maps a HAR 1.1 or 1.2 capture into REST APIs.
 *
 * @throws HarError `har-too-large`, `har-read-failed`, `har-malformed` or `har-not-har`.
 */
export async function importHar(source: HarSource, options: MapHarOptions = {}): Promise<MappedHar> {
  return mapHar(parseHarText(await readHarSource(source)), options);
}
