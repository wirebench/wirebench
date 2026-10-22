import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { tempProjectDir } from './fixture.js';
import { FORMAT_VERSION } from '../../../src/project/model.js';
import { authConfigSchema, definitionAuthSchema, soapOwnerAuthSchema } from '../../../src/project/schema-parts.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const SIGV4 = {
  type: 'aws-sigv4',
  region: 'eu-west-1',
  service: 'execute-api',
  accessKeyIdRef: 'sec_a',
  accessKeyIdEnv: 'AWS_KEY',
  secretAccessKeyRef: 'sec_b',
  sessionTokenRef: 'sec_c',
  placement: 'query',
  expiresSeconds: 600,
};
const V5_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v5', 'project');

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

const DIGEST = { type: 'digest', username: 'admin', passwordRef: 'sec_d', passwordEnv: 'APPLIANCE' };

describe('aws-sigv4 and digest auth in the project format', () => {
  it('need format 10 or later, so an older build refuses the project', () => {
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(10);
  });

  it('leave a version-9 project opening unchanged, rewritten with only its formatVersion line', async () => {
    const dir = await tempProjectDir();
    await cp(V5_DIR, dir, { recursive: true });
    const manifest = join(dir, 'wirebench.yaml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('formatVersion: 5', 'formatVersion: 9'));
    const before = await readAllText(dir);

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(project.formatVersion).toBe(11);
    await saveProject(project, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const expected =
        file === 'wirebench.yaml' ? beforeText.replace('formatVersion: 9', 'formatVersion: 11') : beforeText;
      expect(after.get(file)).toBe(expected);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('are accepted on REST and SOAP owners', () => {
    for (const schema of [authConfigSchema, soapOwnerAuthSchema]) {
      expect(schema.parse(SIGV4)).toEqual(SIGV4);
      expect(schema.parse(DIGEST)).toEqual(DIGEST);
      expect(schema.safeParse({ type: 'aws-sigv4', region: '', service: '' }).success).toBe(true);
      expect(schema.safeParse({ type: 'digest' }).success).toBe(true);
    }
  });

  it('are not definition-fetch credentials', () => {
    expect(definitionAuthSchema.safeParse(SIGV4).success).toBe(false);
    expect(definitionAuthSchema.safeParse(DIGEST).success).toBe(false);
  });

  it('refuse a plaintext key, secret, token or password', () => {
    for (const key of ['accessKeyId', 'secretAccessKey', 'sessionToken']) {
      expect(authConfigSchema.safeParse({ ...SIGV4, [key]: 'AKIA…' }).success).toBe(false);
    }
    expect(authConfigSchema.safeParse({ ...DIGEST, password: 'hunter2' }).success).toBe(false);
    expect(soapOwnerAuthSchema.safeParse({ ...DIGEST, password: 'hunter2' }).success).toBe(false);
  });

  it('refuse an expiry AWS would not accept', () => {
    expect(authConfigSchema.safeParse({ ...SIGV4, expiresSeconds: 0 }).success).toBe(false);
    expect(authConfigSchema.safeParse({ ...SIGV4, expiresSeconds: 604_801 }).success).toBe(false);
    expect(authConfigSchema.safeParse({ ...SIGV4, placement: 'body' }).success).toBe(false);
  });
});
