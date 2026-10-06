import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSourceCache,
  createWorkspace,
  parseSecretSources,
  secretSourcesHash,
  type SecretNeed,
} from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { cliSecrets, cliSecretSourcesOptions, DEFAULT_CLI_SECRET_SOURCES } from '../../src/source-secrets.js';
import { UsageError } from '../../src/usage-error.js';

const sources = parseSecretSources({ db: { kind: 'vault', path: 'kv/app', field: 'password' } }).sources;
const workspace = { ...createWorkspace('W'), secretSources: sources };
const needs: SecretNeed[] = [{ ref: 'secret:db', purpose: 'test' }];

/** A directory holding a fake `vault`, and the env that finds it without the process PATH (spec D3). */
async function fakeVault(body: string): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-cli-src-'));
  await writeFile(join(dir, 'vault'), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, 'vault'), 0o755);
  return { dir, env: { PATH: `${dir}:/usr/bin:/bin` } };
}

describe('cliSecretSourcesOptions', () => {
  it('reads the flags', () => {
    expect(cliSecretSourcesOptions({})).toEqual(DEFAULT_CLI_SECRET_SOURCES);
    expect(cliSecretSourcesOptions({ noSources: true }).enabled).toBe(false);
    expect(cliSecretSourcesOptions({ trustAny: true }).trust).toEqual({ mode: 'any' });
    expect(cliSecretSourcesOptions({ trustHash: 'a'.repeat(64) }).trust).toEqual({
      mode: 'hash',
      hash: 'a'.repeat(64),
    });
  });

  it('refuses both trust flags and a malformed hash', () => {
    expect(() => cliSecretSourcesOptions({ trustAny: true, trustHash: 'a'.repeat(64) })).toThrow(UsageError);
    expect(() => cliSecretSourcesOptions({ trustHash: 'xyz' })).toThrow(UsageError);
  });
});

describe.skipIf(process.platform === 'win32')('cliSecrets', () => {
  it('lets the environment win over a source', async () => {
    const { env } = await fakeVault('echo from-vault');
    const secrets = cliSecrets(
      needs,
      { ...env, WIREBENCH_SECRET_DB: 'from-env' },
      workspace,
      cliSecretSourcesOptions({ trustAny: true }),
      createSourceCache(),
    );
    expect(await secrets.getSecret('secret:db')).toBe('from-env');
  });

  it('reads a trusted source and records the value', async () => {
    const { env } = await fakeVault('echo from-vault');
    const secrets = cliSecrets(needs, env, workspace, cliSecretSourcesOptions({ trustAny: true }), createSourceCache());
    expect(await secrets.getSecret('secret:db')).toBe('from-vault');
    expect(secrets.values()).toContain('from-vault');
  });

  it('refuses an untrusted mapping and names the hash and the flag', async () => {
    const { env } = await fakeVault('echo from-vault');
    const secrets = cliSecrets(needs, env, workspace, DEFAULT_CLI_SECRET_SOURCES, createSourceCache());
    const error = (await secrets.getSecret('secret:db').catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: 'secret-source-untrusted' });
    expect(error.message).toContain(secretSourcesHash(sources) as string);
    expect(error.message).toContain('--trust-secret-sources-hash');
  });

  it('refuses a hash that no longer matches', async () => {
    const { env } = await fakeVault('echo from-vault');
    const secrets = cliSecrets(
      needs,
      env,
      workspace,
      cliSecretSourcesOptions({ trustHash: 'b'.repeat(64) }),
      createSourceCache(),
    );
    await expect(secrets.getSecret('secret:db')).rejects.toMatchObject({ code: 'secret-source-untrusted' });
  });

  it('skips sources with --no-secret-sources and outside a workspace', async () => {
    const { env } = await fakeVault('echo from-vault');
    const off = cliSecrets(needs, env, workspace, cliSecretSourcesOptions({ noSources: true }), createSourceCache());
    expect(await off.getSecret('secret:db')).toBeUndefined();
    const none = cliSecrets(needs, env, undefined, cliSecretSourcesOptions({ trustAny: true }), createSourceCache());
    expect(await none.getSecret('secret:db')).toBeUndefined();
  });

  it('fetches once per cache', async () => {
    const { dir, env } = await fakeVault('echo x >> "$0.count"; echo from-vault');
    const cache = createSourceCache();
    const options = cliSecretSourcesOptions({ trustAny: true });
    await cliSecrets(needs, env, workspace, options, cache).getSecret('secret:db');
    await cliSecrets(needs, env, workspace, options, cache).getSecret('secret:db');
    expect((await readFile(join(dir, 'vault.count'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});
