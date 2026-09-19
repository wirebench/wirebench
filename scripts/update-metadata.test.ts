import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addFiles, updateManifest } from './update-metadata.ts';

const SCRIPT = fileURLToPath(new URL('./update-metadata.ts', import.meta.url));

const MANIFEST = [
  'version: 2.2.0',
  'files:',
  '  - url: Wirebench-2.2.0-windows-x64-setup.exe',
  '    sha512: OLDX64',
  '    size: 1',
  '  - url: Wirebench-2.2.0-windows-arm64-setup.exe',
  '    sha512: OLDARM',
  '    size: 2',
  'path: Wirebench-2.2.0-windows-x64-setup.exe',
  'sha512: OLDX64',
  "releaseDate: '2026-09-19T10:00:00.000Z'",
  '',
].join('\n');

describe('updateManifest', () => {
  it('rewrites each entry and the top-level pair from its own file, and nothing else', () => {
    const updated = updateManifest(MANIFEST, (file) =>
      file.includes('arm64') ? { sha512: 'NEWARM', size: 20 } : { sha512: 'NEWX64', size: 10 },
    );
    expect(updated).toBe(
      MANIFEST.replace('sha512: OLDX64\n    size: 1', 'sha512: NEWX64\n    size: 10')
        .replace('sha512: OLDARM\n    size: 2', 'sha512: NEWARM\n    size: 20')
        .replace('\nsha512: OLDX64', '\nsha512: NEWX64'),
    );
  });
});

describe('addFiles', () => {
  const ONE = MANIFEST.replace(
    '  - url: Wirebench-2.2.0-windows-arm64-setup.exe\n    sha512: OLDARM\n    size: 2\n',
    '',
  );

  it('lists another installer after the last entry, for updateManifest to fill in', () => {
    const added = addFiles(ONE, ['Wirebench-2.2.0-windows-arm64-setup.exe']);
    expect(added).toContain(
      '    size: 1\n  - url: Wirebench-2.2.0-windows-arm64-setup.exe\n    sha512: -\n    size: 0\npath: ',
    );
  });

  it('leaves a manifest alone when it already lists the file', () => {
    expect(addFiles(MANIFEST, ['Wirebench-2.2.0-windows-arm64-setup.exe'])).toBe(MANIFEST);
  });
});

describe('update-metadata.ts', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]): { code: number; out: string } {
    try {
      return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf-8', stdio: 'pipe' }) };
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      return { code: failed.status, out: failed.stderr };
    }
  }

  it('adds the other architecture from a one-entry manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-meta-'));
    writeFileSync(join(dir, 'Wirebench-2.2.0-windows-x64-setup.exe'), 'x');
    writeFileSync(join(dir, 'Wirebench-2.2.0-windows-arm64-setup.exe'), 'arm');
    writeFileSync(
      join(dir, 'latest.yml'),
      MANIFEST.replace('  - url: Wirebench-2.2.0-windows-arm64-setup.exe\n    sha512: OLDARM\n    size: 2\n', ''),
    );

    expect(run(dir, '--add', 'Wirebench-2.2.0-windows-arm64-setup.exe').code).toBe(0);
    const written = readFileSync(join(dir, 'latest.yml'), 'utf-8');
    const arm = createHash('sha512').update('arm').digest('base64');
    expect(written).toContain(`  - url: Wirebench-2.2.0-windows-arm64-setup.exe\n    sha512: ${arm}\n    size: 3`);
    expect(run(dir, '--check').code).toBe(0);
  });

  it('fails --check on a stale manifest, then writes one that passes it', () => {
    dir = mkdtempSync(join(tmpdir(), 'wb-meta-'));
    writeFileSync(join(dir, 'Wirebench-2.2.0-windows-x64-setup.exe'), 'signed x64');
    writeFileSync(join(dir, 'Wirebench-2.2.0-windows-arm64-setup.exe'), 'signed arm64 bytes');
    writeFileSync(join(dir, 'latest.yml'), MANIFEST);

    expect(run(dir, '--check').code).toBe(1);
    expect(run(dir).code).toBe(0);
    expect(run(dir, '--check').code).toBe(0);

    const written = readFileSync(join(dir, 'latest.yml'), 'utf-8');
    expect(written.match(/- url:/g)).toHaveLength(2);
    const x64 = createHash('sha512').update('signed x64').digest('base64');
    expect(written).toContain(`    sha512: ${x64}\n    size: 10`);
    expect(written).toContain(`\nsha512: ${x64}\n`);
    expect(written).toContain("releaseDate: '2026-09-19T10:00:00.000Z'");
  });
});
