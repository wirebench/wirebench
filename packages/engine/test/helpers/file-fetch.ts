/**
 * A `FetchDocument` that reads `file:` locations straight off disk, for tests that import a
 * definition fixture with its relative references.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FetchDocument } from '#protocol-soap/wsdl/resolver';

export const fileFetch: FetchDocument = async (location) => {
  const bytes = new Uint8Array(await readFile(fileURLToPath(location)));
  return { location, bytes, text: new TextDecoder().decode(bytes) };
};
