/**
 * Reading a Postman Collection from a file or text and turning it into a Wirebench REST API.
 */

import { readFile } from 'node:fs/promises';
import { PostmanError } from '../../errors.js';
import type { MapPostmanOptions, MappedPostmanApi } from './map.js';
import { apiFromPostmanCollection } from './map.js';
import type { PostmanCollection } from './model.js';
import { parsePostmanCollectionText } from './parse.js';

/** Where a Postman collection comes from: a file on disk or text already held in memory. */
export type PostmanSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string };

export type ImportPostmanOptions = MapPostmanOptions;

/**
 * Reads, parses, and maps a Postman Collection (v2.0 or v2.1) into a Wirebench REST API.
 *
 * @throws PostmanError when the file cannot be read, the JSON is malformed, or the shape is not a Postman collection.
 */
export async function importPostmanCollection(
  source: PostmanSource,
  options: ImportPostmanOptions = {},
): Promise<MappedPostmanApi> {
  let text: string;
  if (source.kind === 'text') {
    text = source.text;
  } else if (source.kind === 'file') {
    try {
      text = await readFile(source.path, 'utf8');
    } catch (error) {
      throw new PostmanError(
        'postman-read-failed',
        `Failed to read Postman collection from "${source.path}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  } else {
    throw new PostmanError('postman-source-invalid', 'Invalid Postman source provided');
  }

  const collection: PostmanCollection = parsePostmanCollectionText(text);
  return apiFromPostmanCollection(collection, options);
}
