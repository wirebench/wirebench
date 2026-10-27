// @vitest-environment node
/**
 * `writeImportedScripts` takes each name by an exclusive create, not by a check and then a write: a
 * file that appears at the name after every check, just before the write, is never replaced.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ plant: undefined as string | undefined }));
vi.mock('../src/write-new-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/write-new-file.js')>();
  return {
    writeNewFile: async (path: string, data: Buffer): Promise<boolean> => {
      // Another process creates the file in the window a check-then-write would leave.
      if (race.plant !== undefined && path.endsWith(race.plant)) {
        race.plant = undefined;
        await writeFile(path, 'planted');
      }
      return actual.writeNewFile(path, data);
    },
  };
});

import { EngineService } from '../src/engine-service.js';
import { ProjectHost } from '../src/project-host.js';
import { testHooks } from './helpers/project-hooks.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ProjectHost.writeImportedScripts and a file created just before the write', () => {
  it('leaves that file alone and writes the script to the next free name', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wirebench-scripts-race-'));
    made.push(parent);
    const dir = join(parent, 'Race');
    const host = new ProjectHost(new EngineService(), testHooks());
    await host.create({ dir, name: 'Race' });
    race.plant = join('imported-scripts', 'api', 'login.handler.js');

    const result = await host.writeImportedScripts([{ path: 'imported-scripts/api/login.handler.js', source: 'ours' }]);

    expect(await readFile(join(dir, 'imported-scripts', 'api', 'login.handler.js'), 'utf8')).toBe('planted');
    expect(await readFile(join(dir, 'imported-scripts', 'api', 'login-2.handler.js'), 'utf8')).toBe('ours');
    expect(result).toEqual({
      written: ['imported-scripts/api/login-2.handler.js'],
      renamed: [{ from: 'imported-scripts/api/login.handler.js', to: 'imported-scripts/api/login-2.handler.js' }],
      skipped: [],
    });
    await host.close();
  });
});
