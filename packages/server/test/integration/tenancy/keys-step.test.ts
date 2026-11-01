/**
 * The keys step of the self-hosted migration (hosted edition spec §19.7, §19.10, plan Task 24), on the frozen
 * 0019 fixture: the default tenant's data key is made once, by Task 23's compare-and-set, and committed before any
 * blob is sealed under it; every slice 2 blob is re-wrapped; a kill or a rolled-back unit resumes without sealing
 * twice; a re-run counts afresh; without the root the step waits at `keys` and says so.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { open, seal } from '../../../src/hooks/secret-box.js';
import { userSecretsKey } from '../../../src/host/server-platform.js';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { KEYS_WAIT, readTenancyStep, runTenancySteps } from '../../../src/tenancy/file-step.js';
import { environmentKeyRoot, TenantKeys } from '../../../src/tenancy/keys.js';
import type { RewrapCounts } from '../../../src/tenancy/rewrap.js';
import { loadFixture0019, type Fixture0019 } from '../../fixtures/tenancy/load.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';

interface SecretsFile {
  entries: Record<string, { value: string; encrypted: boolean; label?: string }>;
}

describeDb('the keys step on the frozen 0019 fixture (spec §19.10)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let fixture: Fixture0019;
  let root: Buffer;
  let tenantId: string;
  beforeEach(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-keys-step-');
    fixture = await loadFixture0019(db.owner, dataDir);
    await migrate(db.owner, await allMigrations(BUILTIN_MODULES));
    root = Buffer.from(fixture.keys.secretsKey, 'base64');
    tenantId = (await readTenancyStep(db.owner))!.defaultTenantId;
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  const alice = () => fixture.users.alice;
  /** Alice's checkout: where the step moved it, or where the fixture has it before the step. */
  const checkout = () => {
    const moved = join(dataDir, 'tenants', tenantId, fixture.checkout);
    return existsSync(moved) ? moved : join(dataDir, fixture.checkout);
  };
  const storedKey = async (): Promise<Buffer | null> =>
    (await db.owner.query<{ k: Buffer | null }>('select data_key as k from tenants where id = $1', [tenantId])).rows[0]!
      .k;
  /** The data key, as any process opens it from the row. */
  const dataKey = () => new TenantKeys(db.owner, environmentKeyRoot(root)).dataKey(tenantId);
  /** Every blob of Alice's checkout, opened under `key` (the data key's user key, say), or `undefined`. */
  async function plaintexts(key: Buffer): Promise<{ secrets: (string | undefined)[]; jars: (string | undefined)[] }> {
    const tryOpen = (blob: string) => {
      try {
        return open(key, Buffer.from(blob, 'base64'));
      } catch {
        return undefined;
      }
    };
    const file = JSON.parse(await readFile(join(checkout(), 'secrets.json'), 'utf8')) as SecretsFile;
    const secrets = Object.values(file.entries)
      .filter((entry) => entry.encrypted)
      .map((entry) => tryOpen(entry.value));
    const jars: (string | undefined)[] = [];
    for (const name of (await readdir(join(checkout(), 'cookie-jars'))).sort()) {
      const jar = JSON.parse(await readFile(join(checkout(), 'cookie-jars', name), 'utf8')) as { data: string };
      jars.push(tryOpen(jar.data));
    }
    return { secrets, jars };
  }

  it("makes the data key once, re-wraps the fixture's secrets and jars to the same plaintexts, and reaches done", async () => {
    const before = await plaintexts(userSecretsKey(root, alice()));
    expect(before.secrets).toContain(fixture.plaintexts.hostSecret);
    expect(before.jars.every((jar) => jar !== undefined)).toBe(true);
    const counts: RewrapCounts[] = [];
    expect(await runTenancySteps(db.owner, dataDir, { root, onRewrap: (made) => counts.push(made) })).toBe('done');
    const wrapped = await storedKey();
    expect(wrapped).not.toBeNull();
    const userKey = userSecretsKey(await dataKey(), alice());
    // The same plaintexts, now under the data key's user key, and no longer under the root's.
    expect(await plaintexts(userKey)).toEqual(before);
    const old = await plaintexts(userSecretsKey(root, alice()));
    expect([...old.secrets, ...old.jars].every((plain) => plain === undefined)).toBe(true);
    expect(counts).toEqual([
      { resealed: before.secrets.length + before.jars.length, already: 0, unopened: 0, files: 1 + before.jars.length },
    ]);
    expect(before.jars.join('')).toContain(fixture.plaintexts.cookies.staging.split('=')[1]!);
    // Another run of keys, as a re-armed step reaches it again: the same key, nothing sealed, and counts made
    // afresh rather than added to.
    await db.owner.query("update server_identity set tenancy_step = 'keys'");
    const again: RewrapCounts[] = [];
    expect(await runTenancySteps(db.owner, dataDir, { root, onRewrap: (made) => again.push(made) })).toBe('done');
    expect(again).toEqual([{ resealed: 0, already: counts[0]!.resealed, unopened: 0, files: 0 }]);
    expect(await storedKey()).toEqual(wrapped);
    expect(await plaintexts(userKey)).toEqual(before);
  });

  it('a unit rolled back after the re-wrap wrote files keeps the key those files need, and the next run finishes', async () => {
    const before = await plaintexts(userSecretsKey(root, alice()));
    let written = 0;
    const killed = runTenancySteps(db.owner, dataDir, {
      root,
      checkpoint: (part) => {
        if (part === 're-wrapped a file' && ++written === 2) throw new Error('killed after the second file');
      },
    });
    await expect(killed).rejects.toThrow('killed after the second file');
    // The unit rolled back: the step and the moves are as they were, but the key was committed on its own.
    expect((await readTenancyStep(db.owner))?.step).toBe('files');
    const wrapped = await storedKey();
    expect(wrapped).not.toBeNull();
    const counts: RewrapCounts[] = [];
    expect(await runTenancySteps(db.owner, dataDir, { root, onRewrap: (made) => counts.push(made) })).toBe('done');
    // The same key: the re-run took the stored one through the compare-and-set and minted no second.
    expect(await storedKey()).toEqual(wrapped);
    const total = before.secrets.length + before.jars.length;
    expect(counts[0]!.already).toBeGreaterThanOrEqual(2);
    expect(counts[0]!.already + counts[0]!.resealed).toBe(total);
    // Every blob opens under the data key's user key straight to its plaintext: none was sealed twice.
    expect(await plaintexts(userSecretsKey(await dataKey(), alice()))).toEqual(before);
  });

  it('a blob that opens under neither key keeps its bytes, and no jar is set aside', async () => {
    const staging = join(dataDir, fixture.checkout, 'cookie-jars', `${fixture.workspaces.staging}.json`);
    const foreign = JSON.stringify({ version: 1, data: seal(Buffer.alloc(32, 0x99), '[]').toString('base64') });
    await writeFile(staging, foreign);
    const counts: RewrapCounts[] = [];
    expect(await runTenancySteps(db.owner, dataDir, { root, onRewrap: (made) => counts.push(made) })).toBe('done');
    const moved = join(checkout(), 'cookie-jars', `${fixture.workspaces.staging}.json`);
    expect(await readFile(moved, 'utf8')).toBe(foreign);
    expect((await readdir(join(checkout(), 'cookie-jars'))).some((name) => name.endsWith('.corrupt'))).toBe(false);
    expect(counts[0]!.unopened).toBe(1);
  });

  it('a done without a data key is keys again once the root is set', async () => {
    expect(await runTenancySteps(db.owner, dataDir)).toBe('keys');
    // As a build before the keys step would have left it.
    await db.owner.query("update server_identity set tenancy_step = 'done'");
    expect(await runTenancySteps(db.owner, dataDir)).toBe('done');
    expect(await storedKey()).toBeNull();
    expect(await runTenancySteps(db.owner, dataDir, { root })).toBe('done');
    expect(await storedKey()).not.toBeNull();
    expect((await plaintexts(userSecretsKey(await dataKey(), alice()))).secrets).toContain(
      fixture.plaintexts.hostSecret,
    );
  });

  it('without the root the step waits at keys, makes no key, re-wraps nothing, and migrate says why on stderr', async () => {
    const env = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
    };
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const code = await main(args, { stdout, stderr, env: { ...env, ...extra } });
      const text = (mock: typeof stdout) => mock.write.mock.calls.map((c) => String(c[0])).join('');
      return { code, out: text(stdout), err: text(stderr) };
    };
    const migrated = await run(['migrate']);
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('data directory: in the new layout\n');
    expect(migrated.err).toContain(`tenancy step keys: ${KEYS_WAIT}\n`);
    expect((await readTenancyStep(db.owner))?.step).toBe('keys');
    expect(await storedKey()).toBeNull();
    // Still sealed as slice 2 left it.
    expect((await plaintexts(userSecretsKey(root, alice()))).secrets).toContain(fixture.plaintexts.hostSecret);
    // Not pending without the root: nothing waits on the key a server without the browser client never needs.
    expect((await run(['migrate', '--check'])).code).toBe(0);
    // With the root, the keys are due, and migrate does them.
    const withRoot = { WIREBENCH_SERVER_SECRETS_KEY: fixture.keys.secretsKey };
    const due = await run(['migrate', '--check'], withRoot);
    expect(due.code).toBe(1);
    expect(due.out).toContain('pending (step keys)');
    const keyed = await run(['migrate'], withRoot);
    expect(keyed.code).toBe(0);
    expect(keyed.out).toMatch(/re-wrap: \d+ re-sealed under the data key, 0 already under it, 0 opened under neither/);
    expect((await run(['migrate', '--check'], withRoot)).code).toBe(0);
    for (const text of [migrated.out, migrated.err, keyed.out, keyed.err]) {
      expect(text).not.toContain(fixture.keys.secretsKey);
      expect(text).not.toContain(fixture.plaintexts.hostSecret);
    }
  });
});
