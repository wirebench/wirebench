import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const insomniaFixtureDir = fileURLToPath(
  new URL('../../../../../../fixtures/insomnia/crafted/', import.meta.url),
);

/** A crafted Insomnia export's text, by file name. */
export function insomniaFixture(name: string): string {
  return readFileSync(`${insomniaFixtureDir}${name}`, 'utf8');
}
