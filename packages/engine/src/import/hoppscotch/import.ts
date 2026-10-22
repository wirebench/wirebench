/**
 * Reading a Hoppscotch export from a file or text and mapping it. File access stays here, out of
 * the pure reader and mapper.
 */

import { readFile, stat } from 'node:fs/promises';
import { HoppscotchError } from '#core/errors';
import type { MappedClientImport } from '../client-import.js';
import type { MapHoppscotchOptions } from './convert.js';
import { hoppscotchEnvironmentPlan, mapHoppscotch } from './convert.js';
import { MAX_HOPPSCOTCH_BYTES } from './model.js';
import { parseHoppscotchCollections, parseHoppscotchEnvironments } from './parse.js';

export type HoppscotchSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string };

async function readHoppscotchFile(path: string): Promise<string> {
  let size: number | undefined;
  try {
    size = (await stat(path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_HOPPSCOTCH_BYTES) {
    throw new HoppscotchError('hoppscotch-too-large', 'The Hoppscotch export is larger than 50 MB');
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new HoppscotchError(
      'hoppscotch-read-failed',
      `Failed to read the Hoppscotch export "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

const textOf = async (source: HoppscotchSource): Promise<string> =>
  source.kind === 'file' ? await readHoppscotchFile(source.path) : source.text;

/**
 * Reads and maps a collections export.
 *
 * @throws HoppscotchError the reader's and mapper's codes, and `hoppscotch-read-failed`
 */
export async function importHoppscotch(
  source: HoppscotchSource,
  options: MapHoppscotchOptions = {},
): Promise<MappedClientImport> {
  const { collections, report } = parseHoppscotchCollections(await textOf(source));
  return mapHoppscotch(collections, report, options);
}

/**
 * Reads an environments export as an import holding only variables: its environments and Globals.
 *
 * @throws HoppscotchError the reader's codes, `hoppscotch-nothing-to-import` and `hoppscotch-read-failed`
 */
export async function importHoppscotchEnvironments(source: HoppscotchSource): Promise<MappedClientImport> {
  const { environments, report } = parseHoppscotchEnvironments(await textOf(source));
  const variables = hoppscotchEnvironmentPlan(environments, report);
  return {
    collections: [],
    variables,
    scripts: [],
    counts: { collections: 0, requests: 0, folders: 0, examples: 0, assertions: 0, scripts: 0 },
    report: { warnings: [], notes: [] },
  };
}
