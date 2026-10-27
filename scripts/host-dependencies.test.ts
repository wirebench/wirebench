/**
 * `@wirebench/host` is bundled into the desktop's main process, and electron-vite externalises only the
 * desktop's own `dependencies`. A third-party package the host declares but the desktop does not would be
 * bundled silently, miss the asar's native handling and get no row in THIRD-PARTY-LICENSES.md. So every
 * non-workspace host dependency must also be a desktop `dependency`, at the same version spec.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Manifest {
  dependencies?: Record<string, string>;
}

const root = join(import.meta.dirname, '..');
const read = (path: string): Manifest => JSON.parse(readFileSync(join(root, path), 'utf8')) as Manifest;

describe('host dependencies', () => {
  it('are all desktop dependencies at the same version spec', () => {
    const host = read('packages/host/package.json').dependencies ?? {};
    const desktop = read('apps/desktop/package.json').dependencies ?? {};
    const thirdParty = Object.entries(host).filter(([, spec]) => !spec.startsWith('workspace:'));
    expect(thirdParty.length).toBeGreaterThan(0);
    const mismatched = thirdParty
      .filter(([name, spec]) => desktop[name] !== spec)
      .map(([name, spec]) => `${name}: host ${spec}, desktop ${desktop[name] ?? 'missing'}`);
    expect(mismatched).toEqual([]);
  });
});
