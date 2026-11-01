/**
 * The one-time re-wrap (hosted edition spec §19.7, §19.10, plan Task 24): each user's `secrets.json` entries and
 * cookie jars move from slice 2's user key, `HKDF(root, …, userId)`, to the one under the tenant's data key. A blob
 * is tried under the target key first, so a run repeated or resumed never seals twice; one that opens under neither
 * is left exactly as it is, and counted. `back` runs the other way, for the revert.
 */
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, seal } from '../../../src/hooks/secret-box.js';
import { userSecretsKey } from '../../../src/host/server-platform.js';
import { rewrap } from '../../../src/tenancy/rewrap.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';

const ROOT = Buffer.alloc(32, 0x31);
const DATA_KEY = Buffer.alloc(32, 0x32);
const OTHER = Buffer.alloc(32, 0x33);
const ALICE = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
const BOB = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PB';
const KEYS = { root: ROOT, dataKey: DATA_KEY };

const oldKey = (user: string) => userSecretsKey(ROOT, user);
const newKey = (user: string) => userSecretsKey(DATA_KEY, user);
const b64 = (sealed: Buffer) => sealed.toString('base64');

interface SecretsFile {
  version: number;
  entries: Record<string, { value: string; encrypted: boolean; label?: string; createdAt: string }>;
}

describe('rewrap', () => {
  let checkouts: string;
  beforeEach(async () => {
    checkouts = await mkTempDir('wbs-rewrap-');
  });
  afterEach(async () => {
    await removeTempDir(checkouts);
  });

  const at = (user: string, ...parts: string[]) => join(checkouts, user, ...parts);
  const readSecrets = async (user: string) =>
    JSON.parse(await readFile(at(user, 'secrets.json'), 'utf8')) as SecretsFile;
  const readJar = async (user: string, id: string) =>
    JSON.parse(await readFile(at(user, 'cookie-jars', `${id}.json`), 'utf8')) as { version: number; data: string };

  /** Alice: two old entries, one already new, one plaintext, one under neither key; jars likewise. Bob: one old. */
  async function seed(): Promise<{ garbageEntry: string; garbageJar: string }> {
    const garbageEntry = b64(seal(OTHER, 'not ours'));
    const garbageJar = b64(seal(OTHER, '[]'));
    await mkdir(at(ALICE, 'cookie-jars'), { recursive: true });
    await mkdir(at(BOB, 'cookie-jars'), { recursive: true });
    const entry = (value: string, encrypted = true) => ({ value, encrypted, createdAt: '2026-09-24T12:00:00.000Z' });
    await writeFile(
      at(ALICE, 'secrets.json'),
      JSON.stringify(
        {
          version: 2,
          entries: {
            sec_a: { ...entry(b64(seal(oldKey(ALICE), 'alpha'))), label: 'A' },
            sec_b: entry(b64(seal(oldKey(ALICE), 'beta'))),
            sec_c: entry(b64(seal(newKey(ALICE), 'gamma'))),
            sec_d: entry(Buffer.from('plain', 'utf8').toString('base64'), false),
            sec_e: entry(garbageEntry),
          },
        },
        null,
        2,
      ),
    );
    const jar = (key: Buffer, text: string) => JSON.stringify({ version: 1, data: b64(seal(key, text)) });
    await writeFile(at(ALICE, 'cookie-jars', 'ws1.json'), jar(oldKey(ALICE), '["one"]'));
    await writeFile(at(ALICE, 'cookie-jars', 'ws2.json'), jar(newKey(ALICE), '["two"]'));
    await writeFile(at(ALICE, 'cookie-jars', 'ws3.json'), JSON.stringify({ version: 1, data: garbageJar }));
    await writeFile(at(ALICE, 'cookie-jars', 'ws4.json.corrupt'), 'set aside by the host');
    await writeFile(
      at(BOB, 'secrets.json'),
      JSON.stringify({ version: 2, entries: { sec_z: entry(b64(seal(oldKey(BOB), 'zeta'))) } }),
    );
    return { garbageEntry, garbageJar };
  }

  it('re-seals the old blobs under the new key, leaves the new and the plaintext ones, and counts each kind', async () => {
    const { garbageEntry, garbageJar } = await seed();
    const counts = await rewrap(checkouts, KEYS, 'forward');
    expect(counts).toEqual({ resealed: 4, already: 2, unopened: 2, files: 3 });
    const alice = await readSecrets(ALICE);
    expect(open(newKey(ALICE), Buffer.from(alice.entries['sec_a']!.value, 'base64'))).toBe('alpha');
    expect(alice.entries['sec_a']!.label).toBe('A');
    expect(open(newKey(ALICE), Buffer.from(alice.entries['sec_b']!.value, 'base64'))).toBe('beta');
    expect(open(newKey(ALICE), Buffer.from(alice.entries['sec_c']!.value, 'base64'))).toBe('gamma');
    expect(alice.entries['sec_d']).toMatchObject({ value: Buffer.from('plain').toString('base64'), encrypted: false });
    // Under neither key: left exactly as it was.
    expect(alice.entries['sec_e']!.value).toBe(garbageEntry);
    expect(open(newKey(ALICE), Buffer.from((await readJar(ALICE, 'ws1')).data, 'base64'))).toBe('["one"]');
    expect(open(newKey(ALICE), Buffer.from((await readJar(ALICE, 'ws2')).data, 'base64'))).toBe('["two"]');
    expect((await readJar(ALICE, 'ws3')).data).toBe(garbageJar);
    const bob = await readSecrets(BOB);
    expect(open(newKey(BOB), Buffer.from(bob.entries['sec_z']!.value, 'base64'))).toBe('zeta');
    // Nothing is set aside, and the host's own .corrupt file is not touched.
    expect((await readdir(at(ALICE, 'cookie-jars'))).sort()).toEqual([
      'ws1.json',
      'ws2.json',
      'ws3.json',
      'ws4.json.corrupt',
    ]);
    expect(await readFile(at(ALICE, 'cookie-jars', 'ws4.json.corrupt'), 'utf8')).toBe('set aside by the host');
  });

  it('a second run seals nothing, and writes no file', async () => {
    await seed();
    await rewrap(checkouts, KEYS, 'forward');
    const before = await readFile(at(ALICE, 'secrets.json'), 'utf8');
    expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({ resealed: 0, already: 6, unopened: 2, files: 0 });
    expect(await readFile(at(ALICE, 'secrets.json'), 'utf8')).toBe(before);
  });

  it('a run killed after its first file resumes, and nothing is sealed twice', async () => {
    await seed();
    const killed = rewrap(checkouts, KEYS, 'forward', {
      checkpoint: () => {
        throw new Error('killed');
      },
    });
    await expect(killed).rejects.toThrow('killed');
    const resumed = await rewrap(checkouts, KEYS, 'forward');
    expect(resumed.resealed + resumed.already).toBe(6);
    expect(resumed.resealed).toBeLessThan(4);
    // Every blob opens under the new key straight to its plaintext: none was sealed over a sealed one.
    const alice = await readSecrets(ALICE);
    expect(open(newKey(ALICE), Buffer.from(alice.entries['sec_a']!.value, 'base64'))).toBe('alpha');
    expect(open(newKey(ALICE), Buffer.from((await readJar(ALICE, 'ws1')).data, 'base64'))).toBe('["one"]');
    expect(open(newKey(BOB), Buffer.from((await readSecrets(BOB)).entries['sec_z']!.value, 'base64'))).toBe('zeta');
  });

  it('a dry run counts and writes nothing', async () => {
    await seed();
    const before = await readFile(at(ALICE, 'secrets.json'), 'utf8');
    expect(await rewrap(checkouts, KEYS, 'forward', { dryRun: true })).toEqual({
      resealed: 4,
      already: 2,
      unopened: 2,
      files: 0,
    });
    expect(await readFile(at(ALICE, 'secrets.json'), 'utf8')).toBe(before);
  });

  it('back undoes forward: every blob opens under the old key again', async () => {
    await seed();
    await rewrap(checkouts, KEYS, 'forward');
    expect(await rewrap(checkouts, KEYS, 'back')).toEqual({ resealed: 6, already: 0, unopened: 2, files: 4 });
    const alice = await readSecrets(ALICE);
    expect(open(oldKey(ALICE), Buffer.from(alice.entries['sec_c']!.value, 'base64'))).toBe('gamma');
    expect(open(oldKey(ALICE), Buffer.from((await readJar(ALICE, 'ws2')).data, 'base64'))).toBe('["two"]');
    expect(await rewrap(checkouts, KEYS, 'back')).toMatchObject({ resealed: 0, already: 6 });
  });

  it('follows no link, reads no directory that is not a user id, and is fine with no checkouts at all', async () => {
    const elsewhere = await mkTempDir('wbs-rewrap-elsewhere-');
    try {
      const outside = join(elsewhere, 'secrets.json');
      const sealed = b64(seal(oldKey(ALICE), 'outside'));
      const text = JSON.stringify({
        version: 2,
        entries: { sec_o: { value: sealed, encrypted: true, createdAt: 'x' } },
      });
      await writeFile(outside, text);
      await mkdir(at(ALICE), { recursive: true });
      await symlink(outside, at(ALICE, 'secrets.json'));
      await symlink(elsewhere, at(BOB));
      await mkdir(at('not a user', 'cookie-jars'), { recursive: true });
      expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({ resealed: 0, already: 0, unopened: 0, files: 0 });
      expect(await readFile(outside, 'utf8')).toBe(text);
    } finally {
      await removeTempDir(elsewhere);
    }
    expect(await rewrap(join(checkouts, 'absent'), KEYS, 'forward')).toEqual({
      resealed: 0,
      already: 0,
      unopened: 0,
      files: 0,
    });
  });

  it('leaves a file it cannot parse as it is, and counts it unopened', async () => {
    await mkdir(at(ALICE, 'cookie-jars'), { recursive: true });
    await writeFile(at(ALICE, 'secrets.json'), '{ not json');
    await writeFile(at(ALICE, 'cookie-jars', 'ws.json'), JSON.stringify({ version: 9, other: true }));
    expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({ resealed: 0, already: 0, unopened: 2, files: 0 });
    expect(await readFile(at(ALICE, 'secrets.json'), 'utf8')).toBe('{ not json');
  });
});
