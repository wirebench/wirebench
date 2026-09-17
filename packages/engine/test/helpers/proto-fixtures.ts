/**
 * Reads the crafted `.proto` fixtures under `fixtures/proto/crafted/<name>/` into the
 * import-path-keyed map `loadProtoSet` takes, walking the directory so nested import paths
 * (`wirebench/common/address.proto`) come out as the imports spell them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const craftedDir = fileURLToPath(new URL('../../../../fixtures/proto/crafted/', import.meta.url));

/** The directory of one crafted fixture. */
export function protoFixtureDir(name: string): string {
  return join(craftedDir, name);
}

/** Every `.proto` under the fixture, keyed by `/`-separated path relative to the fixture directory. */
export function readProtoFixture(name: string): Map<string, string> {
  const root = protoFixtureDir(name);
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${path}/`);
      } else if (entry.name.endsWith('.proto')) {
        files.set(path, readFileSync(join(dir, entry.name), 'utf8'));
      }
    }
  };
  walk(root, '');
  return files;
}
