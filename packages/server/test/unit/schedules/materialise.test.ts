import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { SyncFile } from '@wirebench/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materialise } from '../../../src/schedules/materialise.js';
import { RunStopped } from '../../../src/schedules/outcome.js';

const utf8 = (path: string, content: string): SyncFile => ({ path, encoding: 'utf8', content });

const FILES: SyncFile[] = [
  utf8('workspace.yaml', 'name: W\n'),
  utf8('.gitattributes', '* text=auto\n'),
  utf8('environments/prod.yaml', 'name: prod\n'),
  utf8('projects/Billing API/project.yaml', 'name: Billing\n'),
  {
    path: 'projects/Billing API/attachments/logo.bin',
    encoding: 'base64',
    content: Buffer.from([0, 1, 2]).toString('base64'),
  },
  utf8('projects/orders/project.yaml', 'name: Orders\n'),
  utf8('team-secrets/values/API.yaml', 'sealed\n'),
];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-materialise-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .split(sep)
        .join('/'),
    )
    .sort();
}

describe('materialise (scheduled-runs spec §3.2 step 1)', () => {
  it('writes the manifest, the environments and then the target project only, private to the server', async () => {
    const snapshot = await materialise({ root, runId: 'R1', files: FILES, maxBytes: 1024 });
    expect(snapshot.dir).toBe(join(root, 'R1'));
    expect(await tree(snapshot.dir)).toEqual(['environments/prod.yaml', 'workspace.yaml']);
    // Windows has no POSIX modes: the folder's privacy there is its ACL, inherited from the data dir.
    if (process.platform !== 'win32') expect((await stat(snapshot.dir)).mode & 0o777).toBe(0o700);
    await snapshot.addProject('Billing API');
    expect(await tree(snapshot.dir)).toEqual([
      'environments/prod.yaml',
      'projects/Billing API/attachments/logo.bin',
      'projects/Billing API/project.yaml',
      'workspace.yaml',
    ]);
    expect([...(await readFile(join(snapshot.dir, 'projects/Billing API/attachments/logo.bin')))]).toEqual([0, 1, 2]);
    expect(await readFile(join(snapshot.dir, 'workspace.yaml'), 'utf8')).toBe('name: W\n');
    await snapshot.dispose();
    await expect(stat(snapshot.dir)).rejects.toThrow();
    await snapshot.dispose();
  });

  it('refuses a snapshot over the cap, counting decoded bytes, and leaves nothing behind', async () => {
    const big = [utf8('workspace.yaml', 'x'.repeat(60)), utf8('projects/billing/project.yaml', 'y'.repeat(60))];
    const snapshot = await materialise({ root, runId: 'R2', files: big, maxBytes: 100 });
    const refused = snapshot.addProject('billing');
    await expect(refused).rejects.toBeInstanceOf(RunStopped);
    await expect(refused).rejects.toMatchObject({ reason: 'snapshot-too-large' });
    expect(await readdir(root)).toEqual([]);
  });

  it('a file of another project does not count toward the cap', async () => {
    const files = [utf8('workspace.yaml', 'a'), utf8('projects/orders/big.yaml', 'z'.repeat(500))];
    const snapshot = await materialise({ root, runId: 'R3', files, maxBytes: 100 });
    await snapshot.addProject('billing');
    expect(await tree(snapshot.dir)).toEqual(['workspace.yaml']);
    await snapshot.dispose();
  });

  it('refuses a path that would escape the run directory', async () => {
    for (const path of ['projects/billing/../../../escape.yaml', 'environments/../../x', '/etc/passwd', 'a\\..\\b']) {
      const refused = materialise({ root, runId: 'R4', files: [utf8(path, 'x')], maxBytes: 100 });
      await expect(refused).rejects.toMatchObject({ reason: 'snapshot-path-refused' });
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a project that is not one path segment, and cleans up', async () => {
    const snapshot = await materialise({ root, runId: 'R5', files: FILES, maxBytes: 1024 });
    await expect(snapshot.addProject('../billing')).rejects.toMatchObject({ reason: 'target-invalid' });
    expect(await readdir(root)).toEqual([]);
  });
});
