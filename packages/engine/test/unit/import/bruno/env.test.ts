import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { ocOfBrunoFolder } from '../../../../src/import/bruno/convert.js';
import { importBruno, mapBruno } from '../../../../src/import/bruno/import.js';
import { brunoFiles, brunoFixtureDir } from './fixtures.js';

const mapped = (): MappedClientImport => {
  const { collection, report } = ocOfBrunoFolder(brunoFiles(), 'basic');
  return mapBruno(collection, report);
};
const env = (result: MappedClientImport, name: string) => result.variables.environments.find((e) => e.name === name);
const warnings = (result: MappedClientImport): string[] => [
  ...result.report.warnings,
  ...result.variables.report.warnings,
];

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Bruno environments', () => {
  it('becomes one workspace environment per file, a ~ entry disabled', () => {
    const local = env(mapped(), 'Local');
    expect(local?.variables.find((v) => v.name === 'baseUrl')).toMatchObject({
      value: 'http://localhost:8080',
      enabled: true,
    });
    expect(local?.variables.find((v) => v.name === 'debugFlag')).toMatchObject({ value: 'true', enabled: false });
  });

  it('lists a vars:secret name as a secret with no value', () => {
    const secret = env(mapped(), 'Local')?.variables.find((v) => v.name === 'clientSecret');
    expect(secret).toMatchObject({ secret: true, value: '' });
    expect(secret).not.toHaveProperty('secretValue');
  });

  it('reads a {{process.env.X}} value as a system property', () => {
    expect(env(mapped(), 'Local')?.variables.find((v) => v.name === 'apiToken')?.value).toBe('${#System#TOKEN}');
  });

  it('reports extends and color', () => {
    expect(warnings(mapped())).toEqual(
      expect.arrayContaining([
        'Prod: color is not supported and was not imported.',
        'Prod: extends is not supported and was not imported.',
      ]),
    );
  });

  it('reports vars:externalsecrets', async () => {
    const dir = tempDir('wirebench-bruno-env-');
    writeFileSync(join(dir, 'bruno.json'), '{"version":"1","name":"x","type":"collection"}');
    writeFileSync(join(dir, 'ping.bru'), 'get {\n  url: http://h\n}\n');
    cpSync(join(brunoFixtureDir, 'basic', 'environments'), join(dir, 'environments'), { recursive: true });
    writeFileSync(
      join(dir, 'environments', 'Vault.bru'),
      'vars {\n  a: 1\n}\nvars:externalsecrets:aws {\n  key: path\n}\n',
    );
    const result = await importBruno({ kind: 'folder', path: dir });
    expect(warnings(result)).toContain('Vault: vars:externalsecrets:aws is not supported and was not imported.');
  });

  it('never reads a .env file beside the collection', async () => {
    const dir = tempDir('wirebench-bruno-dotenv-');
    cpSync(join(brunoFixtureDir, 'basic'), dir, { recursive: true });
    writeFileSync(join(dir, '.env'), 'TOKEN=dotenv-value-must-not-appear\n');
    writeFileSync(join(dir, '.env.local'), 'TOKEN=dotenv-local-must-not-appear\n');
    const all = JSON.stringify(await importBruno({ kind: 'folder', path: dir }), (_k: string, v: unknown): unknown =>
      v instanceof Map ? Object.fromEntries(v) : v,
    );
    expect(all).not.toContain('dotenv-value-must-not-appear');
    expect(all).not.toContain('dotenv-local-must-not-appear');
  });
});
