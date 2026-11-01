/**
 * The one-time re-wrap (hosted edition spec §19.7, §19.10, plan Task 24): each user's `secrets.json` entries and
 * cookie jars move from slice 2's user key, `HKDF(root, …, userId)`, to the one under the tenant's data key. A blob
 * is tried under the target key first, so a run repeated or resumed never seals twice; one that opens under neither
 * is left exactly as it is, and counted. `back` runs the other way, for the revert.
 */
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, seal } from '../../../src/hooks/secret-box.js';
import { userSecretsKey } from '../../../src/host/server-platform.js';
import { rewrap, writeFileDurably, type DurableFs } from '../../../src/tenancy/rewrap.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { canSymlink } from '../../helpers/symlink.js';

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
    expect(counts).toEqual({ resealed: 4, already: 2, unopened: 2, skipped: 0, unreadable: 0, codes: [], files: 3 });
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
    expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({
      resealed: 0,
      already: 6,
      unopened: 2,
      skipped: 0,
      unreadable: 0,
      codes: [],
      files: 0,
    });
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
      skipped: 0,
      unreadable: 0,
      codes: [],
      files: 0,
    });
    expect(await readFile(at(ALICE, 'secrets.json'), 'utf8')).toBe(before);
  });

  it('back undoes forward: every blob opens under the old key again', async () => {
    await seed();
    await rewrap(checkouts, KEYS, 'forward');
    expect(await rewrap(checkouts, KEYS, 'back')).toEqual({
      resealed: 6,
      already: 0,
      unopened: 2,
      skipped: 0,
      unreadable: 0,
      codes: [],
      files: 4,
    });
    const alice = await readSecrets(ALICE);
    expect(open(oldKey(ALICE), Buffer.from(alice.entries['sec_c']!.value, 'base64'))).toBe('gamma');
    expect(open(oldKey(ALICE), Buffer.from((await readJar(ALICE, 'ws2')).data, 'base64'))).toBe('["two"]');
    expect(await rewrap(checkouts, KEYS, 'back')).toMatchObject({ resealed: 0, already: 6 });
  });

  it.skipIf(!canSymlink)(
    'follows no link but counts each one skipped, reads no directory that is not a user id, and is fine with no checkouts at all',
    async () => {
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
        // The host follows such links, and would set aside what it finds: so each one is counted (review m1).
        expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({
          resealed: 0,
          already: 0,
          unopened: 0,
          skipped: 2,
          unreadable: 0,
          codes: [],
          files: 0,
        });
        expect(await readFile(outside, 'utf8')).toBe(text);
      } finally {
        await removeTempDir(elsewhere);
      }
      expect(await rewrap(join(checkouts, 'absent'), KEYS, 'forward')).toEqual({
        resealed: 0,
        already: 0,
        unopened: 0,
        skipped: 0,
        unreadable: 0,
        codes: [],
        files: 0,
      });
    },
  );

  it('leaves a file it cannot parse as it is, and counts it unopened', async () => {
    await mkdir(at(ALICE, 'cookie-jars'), { recursive: true });
    await writeFile(at(ALICE, 'secrets.json'), '{ not json');
    await writeFile(at(ALICE, 'cookie-jars', 'ws.json'), JSON.stringify({ version: 9, other: true }));
    expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({
      resealed: 0,
      already: 0,
      unopened: 2,
      skipped: 0,
      unreadable: 0,
      codes: [],
      files: 0,
    });
    expect(await readFile(at(ALICE, 'secrets.json'), 'utf8')).toBe('{ not json');
  });

  it('a malformed entry is counted and kept, and stops no other entry of the file (review m2)', async () => {
    await mkdir(at(ALICE), { recursive: true });
    const sealed = b64(seal(oldKey(ALICE), 'alpha'));
    await writeFile(
      at(ALICE, 'secrets.json'),
      JSON.stringify({
        version: 2,
        entries: {
          sec_a: { value: sealed, encrypted: true, createdAt: 'x' },
          sec_bad: { value: 42, encrypted: true, createdAt: 'x' },
          sec_odd: 'not an entry',
        },
      }),
    );
    expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({
      resealed: 1,
      already: 0,
      unopened: 2,
      skipped: 0,
      unreadable: 0,
      codes: [],
      files: 1,
    });
    const file = JSON.parse(await readFile(at(ALICE, 'secrets.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(open(newKey(ALICE), Buffer.from((file.entries['sec_a'] as { value: string }).value, 'base64'))).toBe(
      'alpha',
    );
    expect(file.entries['sec_bad']).toEqual({ value: 42, encrypted: true, createdAt: 'x' });
    expect(file.entries['sec_odd']).toBe('not an entry');
  });

  it('a version 1 secrets.json: re-sealed when the file is encrypted, left when it is not, and stays version 1 (review m3)', async () => {
    await mkdir(at(ALICE), { recursive: true });
    await mkdir(at(BOB), { recursive: true });
    const v1 = (encrypted: boolean, value: string) =>
      JSON.stringify({ version: 1, encrypted, entries: { sec_a: { value, label: 'A', createdAt: 'x' } } }, null, 2);
    await writeFile(at(ALICE, 'secrets.json'), v1(true, b64(seal(oldKey(ALICE), 'alpha'))));
    const plain = v1(false, Buffer.from('plain').toString('base64'));
    await writeFile(at(BOB, 'secrets.json'), plain);
    expect(await rewrap(checkouts, KEYS, 'forward')).toEqual({
      resealed: 1,
      already: 0,
      unopened: 0,
      skipped: 0,
      unreadable: 0,
      codes: [],
      files: 1,
    });
    // The host migrates version 1 on load; the re-wrap keeps the shape it reads, and changes only the value.
    const alice = JSON.parse(await readFile(at(ALICE, 'secrets.json'), 'utf8')) as {
      version: number;
      encrypted: boolean;
      entries: Record<string, { value: string; label: string }>;
    };
    expect(alice).toMatchObject({ version: 1, encrypted: true, entries: { sec_a: { label: 'A', createdAt: 'x' } } });
    expect(open(newKey(ALICE), Buffer.from(alice.entries['sec_a']!.value, 'base64'))).toBe('alpha');
    expect(await readFile(at(BOB, 'secrets.json'), 'utf8')).toBe(plain);
    expect(await rewrap(checkouts, KEYS, 'forward')).toMatchObject({ resealed: 0, already: 1, files: 0 });
  });

  it.skipIf(process.platform === 'win32')(
    "keeps each file's mode, whatever the umask, and leaves no temporary file (review I1)",
    async () => {
      await seed();
      await chmod(at(ALICE, 'secrets.json'), 0o600);
      await chmod(at(ALICE, 'cookie-jars', 'ws1.json'), 0o640);
      const umask = process.umask(0o022);
      try {
        await rewrap(checkouts, KEYS, 'forward');
      } finally {
        process.umask(umask);
      }
      expect((await stat(at(ALICE, 'secrets.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(at(ALICE, 'cookie-jars', 'ws1.json'))).mode & 0o777).toBe(0o640);
      expect((await readdir(at(ALICE))).sort()).toEqual(['cookie-jars', 'secrets.json']);
      expect((await readdir(at(ALICE, 'cookie-jars'))).some((name) => name.includes('.tmp-'))).toBe(false);
    },
  );
});

describe('rewrap, lenient (Part D review P1)', () => {
  let checkouts: string;
  beforeEach(async () => {
    checkouts = await mkTempDir('wbs-rewrap-lenient-');
  });
  afterEach(async () => {
    await chmod(join(checkouts, ALICE, 'secrets.json'), 0o600).catch(() => undefined);
    await removeTempDir(checkouts);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'counts a file it cannot read by its code, and re-wraps the rest; a strict run throws',
    async () => {
      for (const user of [ALICE, BOB]) {
        await mkdir(join(checkouts, user, 'cookie-jars'), { recursive: true });
        await writeFile(
          join(checkouts, user, 'cookie-jars', 'ws.json'),
          JSON.stringify({ version: 1, data: b64(seal(oldKey(user), '[]')) }),
        );
      }
      await writeFile(join(checkouts, ALICE, 'secrets.json'), '{}');
      await chmod(join(checkouts, ALICE, 'secrets.json'), 0o000);
      await expect(rewrap(checkouts, KEYS, 'forward')).rejects.toMatchObject({ code: 'EACCES' });
      expect(await rewrap(checkouts, KEYS, 'forward', { lenient: true })).toEqual({
        resealed: 2,
        already: 0,
        unopened: 0,
        skipped: 0,
        unreadable: 1,
        codes: ['EACCES'],
        files: 2,
      });
    },
  );

  it('a test checkpoint, which carries no code, is thrown even when lenient', async () => {
    await mkdir(join(checkouts, ALICE, 'cookie-jars'), { recursive: true });
    await writeFile(
      join(checkouts, ALICE, 'cookie-jars', 'ws.json'),
      JSON.stringify({ version: 1, data: b64(seal(oldKey(ALICE), '[]')) }),
    );
    const run = rewrap(checkouts, KEYS, 'forward', {
      lenient: true,
      checkpoint: () => {
        throw new Error('killed');
      },
    });
    await expect(run).rejects.toThrow('killed');
  });
});

describe('writeFileDurably (review I1)', () => {
  /** A file system that records each call, in order, and writes nothing. */
  function recording(platform: NodeJS.Platform, fail: { readonly rename?: Error; readonly dirSync?: Error } = {}) {
    const calls: string[] = [];
    const done = (): Promise<void> => Promise.resolve();
    const handle = (path: string) => ({
      chmod: (mode: number) => {
        calls.push(`chmod ${path} ${mode.toString(8)}`);
        return done();
      },
      writeFile: () => {
        calls.push(`write ${path}`);
        return done();
      },
      sync: () => {
        calls.push(`sync ${path}`);
        return path === '/d' && fail.dirSync !== undefined ? Promise.reject(fail.dirSync) : done();
      },
      close: () => {
        calls.push(`close ${path}`);
        return done();
      },
    });
    const temp = (path: string) => path.replace(/tmp-[0-9a-f]+$/, 'tmp');
    const fs: DurableFs = {
      stat: () => Promise.resolve({ mode: 0o100600 }),
      open: (path, flags, mode) => {
        calls.push(`open ${temp(path)} ${flags}${mode === undefined ? '' : ` ${mode.toString(8)}`}`);
        return Promise.resolve(handle(temp(path)));
      },
      rename: (from, to) => {
        calls.push(`rename ${temp(from)} ${to}`);
        return fail.rename !== undefined ? Promise.reject(fail.rename) : done();
      },
      rm: (path) => {
        calls.push(`rm ${temp(path)}`);
        return done();
      },
      platform,
    };
    return { calls, fs };
  }

  it("writes an exclusive temporary file with the original's mode, fsyncs it, renames it, then fsyncs the directory", async () => {
    const { calls, fs } = recording('linux');
    await writeFileDurably('/d/secrets.json', '{}', fs);
    expect(calls).toEqual([
      'open /d/secrets.json.tmp wx 600',
      'chmod /d/secrets.json.tmp 600',
      'write /d/secrets.json.tmp',
      'sync /d/secrets.json.tmp',
      'close /d/secrets.json.tmp',
      'rename /d/secrets.json.tmp /d/secrets.json',
      'open /d r',
      'sync /d',
      'close /d',
    ]);
  });

  it('on Windows, where a directory cannot be fsynced, stops after the rename', async () => {
    const { calls, fs } = recording('win32');
    await writeFileDurably('/d/secrets.json', '{}', fs);
    expect(calls.at(-1)).toBe('rename /d/secrets.json.tmp /d/secrets.json');
  });

  it('a failed rename removes the temporary file and throws; a directory fsync that fails with EIO throws', async () => {
    const failed = recording('linux', { rename: Object.assign(new Error('no'), { code: 'EXDEV' }) });
    await expect(writeFileDurably('/d/secrets.json', '{}', failed.fs)).rejects.toThrow('no');
    expect(failed.calls.at(-1)).toBe('rm /d/secrets.json.tmp');
    const io = recording('linux', { dirSync: Object.assign(new Error('io'), { code: 'EIO' }) });
    await expect(writeFileDurably('/d/secrets.json', '{}', io.fs)).rejects.toThrow('io');
    expect(io.calls.at(-1)).toBe('close /d');
    const unsupported = recording('linux', { dirSync: Object.assign(new Error('inval'), { code: 'EINVAL' }) });
    await writeFileDurably('/d/secrets.json', '{}', unsupported.fs);
  });

  it('rewrap writes every file through it', async () => {
    const { calls, fs } = recording('linux');
    const dir = await mkTempDir('wbs-rewrap-durable-');
    try {
      const home = join(dir, ALICE);
      await mkdir(home);
      const text = JSON.stringify({
        version: 2,
        entries: { sec_a: { value: b64(seal(oldKey(ALICE), 'a')), encrypted: true, createdAt: 'x' } },
      });
      await writeFile(join(home, 'secrets.json'), text);
      expect(await rewrap(dir, KEYS, 'forward', { fs })).toMatchObject({ resealed: 1, files: 1 });
      // The file, then its directory, both before rewrap returns (so before the step records done).
      expect(calls.filter((call) => call.startsWith('sync'))).toEqual([
        `sync ${join(home, 'secrets.json.tmp')}`,
        `sync ${home}`,
      ]);
    } finally {
      await removeTempDir(dir);
    }
  });
});
