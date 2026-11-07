import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generatedKeyNotice,
  resolveSecretsKey,
  SECRETS_KEY_FILE,
  SecretsKeyFileError,
} from '../../src/secrets-key-file.js';
import { mkTempDir, removeTempDir } from '../helpers/git.js';
import type { ServerConfig } from '../../src/config.js';

const posix = process.platform !== 'win32';

type KeyConfig = Pick<ServerConfig, 'mode' | 'instances' | 'dataDir' | 'secretsKey'>;
/** A key as the configuration types it. */
const asKey = (bytes: Buffer) => bytes as NonNullable<ServerConfig['secretsKey']>;

describe('resolveSecretsKey', () => {
  let dataDir: string;
  const config = (extra: Partial<KeyConfig> = {}): KeyConfig => ({
    mode: 'self-hosted',
    instances: 'single',
    dataDir,
    ...extra,
  });
  const keyPath = () => join(dataDir, SECRETS_KEY_FILE);
  beforeEach(async () => {
    dataDir = await mkTempDir('wbs-key-');
  });
  afterEach(async () => {
    await removeTempDir(dataDir);
  });

  it('generates a 32-byte key at the first start and stores it base64, mode 0600', async () => {
    const resolved = await resolveSecretsKey(config(), { create: true });
    expect(resolved.source).toBe('generated');
    expect(resolved.path).toBe(keyPath());
    expect(resolved.key).toHaveLength(32);
    const text = await readFile(keyPath(), 'utf8');
    expect(text).toBe(`${resolved.key!.toString('base64')}\n`);
    if (posix) expect((await stat(keyPath())).mode & 0o777).toBe(0o600);
    // No temporary file is left beside it.
    expect(await readdir(dataDir)).toEqual([SECRETS_KEY_FILE]);
  });

  it('makes the data directory when it is not there yet', async () => {
    const nested = join(dataDir, 'not', 'yet');
    const resolved = await resolveSecretsKey(config({ dataDir: nested }), { create: true });
    expect(resolved.source).toBe('generated');
    expect(await readdir(nested)).toEqual([SECRETS_KEY_FILE]);
  });

  it('reuses the stored key at later starts', async () => {
    const first = await resolveSecretsKey(config(), { create: true });
    const second = await resolveSecretsKey(config(), { create: true });
    expect(second.source).toBe('file');
    expect(second.key!.equals(first.key!)).toBe(true);
  });

  it('keeps one key when two starts race', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveSecretsKey(config(), { create: true })));
    const keys = new Set(results.map((result) => result.key!.toString('base64')));
    expect(keys.size).toBe(1);
    expect(results.filter((result) => result.source === 'generated')).toHaveLength(1);
    expect(await readdir(dataDir)).toEqual([SECRETS_KEY_FILE]);
  });

  it('accepts a key file written by openssl rand -base64 32', async () => {
    const key = randomBytes(32);
    await writeFile(keyPath(), `${key.toString('base64')}\n`, { mode: 0o600 });
    const resolved = await resolveSecretsKey(config(), { create: true });
    expect(resolved).toMatchObject({ source: 'file' });
    expect(resolved.key!.equals(key)).toBe(true);
  });

  it('lets the variable win over a stored key, and touches no file', async () => {
    const stored = await resolveSecretsKey(config(), { create: true });
    const variable = asKey(randomBytes(32));
    const resolved = await resolveSecretsKey(config({ secretsKey: variable }), { create: true });
    expect(resolved).toEqual({ key: variable, source: 'variable' });
    expect(resolved.key!.equals(stored.key!)).toBe(false);
  });

  it('with the variable set and no file, makes none', async () => {
    const variable = asKey(randomBytes(32));
    expect(await resolveSecretsKey(config({ secretsKey: variable }), { create: true })).toEqual({
      key: variable,
      source: 'variable',
    });
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('never makes or reads a file in hosted mode or with several instances', async () => {
    await writeFile(keyPath(), `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    for (const extra of [{ mode: 'hosted' }, { instances: 'multi' }] as const) {
      expect(await resolveSecretsKey(config(extra), { create: true })).toEqual({ key: undefined, source: 'none' });
    }
    const empty = await mkTempDir('wbs-key-');
    try {
      await resolveSecretsKey(config({ dataDir: empty, instances: 'multi' }), { create: true });
      expect(await readdir(empty)).toEqual([]);
    } finally {
      await removeTempDir(empty);
    }
  });

  it('without create, reads a stored key but makes none', async () => {
    expect(await resolveSecretsKey(config(), { create: false })).toEqual({
      key: undefined,
      source: 'none',
      path: keyPath(),
    });
    expect(await readdir(dataDir)).toEqual([]);
    const made = await resolveSecretsKey(config(), { create: true });
    const read = await resolveSecretsKey(config(), { create: false });
    expect(read.source).toBe('file');
    expect(read.key!.equals(made.key!)).toBe(true);
  });

  describe('refuses a key file it will not use, and leaves it as it was', () => {
    const refusal = async (): Promise<SecretsKeyFileError> => {
      const error = await resolveSecretsKey(config(), { create: true }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SecretsKeyFileError);
      return error as SecretsKeyFileError;
    };

    it.each([
      ['too short', `${randomBytes(16).toString('base64')}\n`],
      ['too long', `${randomBytes(48).toString('base64')}\n`],
      ['not base64', 'not a key at all, but some words\n'],
      ['empty', ''],
      ['hex', `${randomBytes(32).toString('hex')}\n`],
    ])('%s', async (_name, content) => {
      await writeFile(keyPath(), content, { mode: 0o600 });
      const error = await refusal();
      expect(error.message).toContain(keyPath());
      expect(error.message).toContain('is not a secrets key');
      if (content !== '') expect(error.message).not.toContain(content.trim());
      expect(await readFile(keyPath(), 'utf8')).toBe(content);
    });

    it('larger than any key', async () => {
      await writeFile(keyPath(), 'A'.repeat(4096), { mode: 0o600 });
      expect((await refusal()).message).toContain('is not a secrets key');
    });

    it.runIf(posix).each([0o640, 0o604, 0o660, 0o644])('open to the group or others (mode %o)', async (mode) => {
      const content = `${randomBytes(32).toString('base64')}\n`;
      await writeFile(keyPath(), content);
      await chmod(keyPath(), mode);
      const error = await refusal();
      expect(error.message).toContain('chmod 600');
      expect(error.message).not.toContain(content.trim());
      expect(await readFile(keyPath(), 'utf8')).toBe(content);
    });

    it.runIf(posix)('unreadable', async () => {
      await writeFile(keyPath(), `${randomBytes(32).toString('base64')}\n`);
      await chmod(keyPath(), 0o000);
      // Root reads any file; the refusal is then the mode's own rule, so the test asks only for a refusal.
      try {
        await refusal();
      } finally {
        await chmod(keyPath(), 0o600);
      }
    });

    it.runIf(posix)('a symbolic link', async () => {
      const target = join(dataDir, 'elsewhere');
      await writeFile(target, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
      await symlink(target, keyPath());
      expect((await refusal()).message).toContain('symbolic link');
    });

    it('a directory', async () => {
      await mkdir(keyPath());
      await refusal();
    });
  });

  it('says where the generated key is, and never the key', async () => {
    const resolved = await resolveSecretsKey(config(), { create: true });
    const notice = generatedKeyNotice(resolved.path!);
    expect(notice).toContain(keyPath());
    expect(notice).toContain('Back that file up');
    expect(notice).not.toContain(resolved.key!.toString('base64'));
  });
});
