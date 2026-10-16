import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const brunoFixtureDir = fileURLToPath(new URL('../../../../../../fixtures/bruno/crafted/', import.meta.url));

/**
 * A crafted Bruno collection's files as the folder walk hands them over: root-relative POSIX paths
 * to text, `mocks/` and `.env*` left out as the walk leaves them.
 */
export function brunoFiles(name = 'basic'): Map<string, string> {
  const root = join(brunoFixtureDir, name);
  const files = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (path !== 'mocks') walk(join(dir, entry.name), path);
      } else if (!entry.name.startsWith('.env')) {
        files.set(path, readFileSync(join(dir, entry.name), 'utf8'));
      }
    }
  };
  walk(root, '');
  return files;
}
