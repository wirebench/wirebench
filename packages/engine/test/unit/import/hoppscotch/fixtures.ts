import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const hoppscotchFixtureDir = fileURLToPath(
  new URL('../../../../../../fixtures/hoppscotch/crafted/', import.meta.url),
);

export function hoppscotchFixture(name: string): string {
  return readFileSync(`${hoppscotchFixtureDir}${name}`, 'utf8');
}
