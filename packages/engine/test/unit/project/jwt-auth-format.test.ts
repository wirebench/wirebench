/**
 * Format 10 (#348): an auth can be a client-signed JWT, which a format-9 build cannot read. A
 * format-9 folder still opens as it was and is written back with only the version line changed; a
 * file from a newer build is refused as too new rather than failing on an unknown auth type.
 */
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectError } from '../../../src/errors.js';
import { loadProject } from '../../../src/project/load.js';
import { FORMAT_VERSION } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { authConfigSchema, soapOwnerAuthSchema } from '../../../src/project/schema-parts.js';
import { sampleProject, tempProjectDir } from './fixture.js';

const JWT = {
  type: 'jwt',
  algorithm: 'RS256',
  keystoreRef: 'ks-1',
  claims: '{"sub":"svc"}',
  issuedAt: true,
  expiresInSeconds: 300,
  jwtId: true,
  in: 'header',
  prefix: '',
};

async function readAllText(dir: string, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of await readAllText(join(dir, entry.name), relative)) out.set(k, v);
    } else {
      out.set(relative, await readFile(join(dir, entry.name), 'utf8'));
    }
  }
  return out;
}

describe('jwt auth in the project format', () => {
  it('is format 10 or later', () => {
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(10);
  });

  it('is an auth for requests and APIs, not for SOAP owners', () => {
    expect(authConfigSchema.safeParse(JWT).success).toBe(true);
    expect(soapOwnerAuthSchema.safeParse(JWT).success).toBe(false);
  });

  it('opens a format-9 folder unchanged and writes it back with only the version line changed', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const manifest = join(dir, 'wirebench.yaml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('formatVersion: 11', 'formatVersion: 9'));
    const before = await readAllText(dir);

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    await saveProject(project, dir);

    const after = await readAllText(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, text] of after) {
      const old = before.get(file) ?? '';
      expect(text).toBe(file === 'wirebench.yaml' ? old.replace('formatVersion: 9', 'formatVersion: 11') : old);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a file from a newer build as too new', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    const manifest = join(dir, 'wirebench.yaml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('formatVersion: 11', 'formatVersion: 12'));

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;
    expect(error.code).toBe('project-format-too-new');
    expect(error.details).toMatchObject({ formatVersion: 12, supported: 11 });
    await rm(dir, { recursive: true, force: true });
  });
});
