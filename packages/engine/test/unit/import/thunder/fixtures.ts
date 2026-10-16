import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const thunderFixtureDir = fileURLToPath(
  new URL('../../../../../../fixtures/thunder-client/crafted/', import.meta.url),
);

export function thunderFixture(name: string): string {
  return readFileSync(`${thunderFixtureDir}${name}`, 'utf8');
}
