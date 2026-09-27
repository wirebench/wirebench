// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTeamSecretsFile, vaultEntryFileSchema, vaultEntryId, vaultEntryPath } from '@wirebench/engine';
import { SecretStore, type CryptoBackend } from '../src/main/secrets.js';
import { TeamSecretsService, type SecretUse, type TeamSecretsWorkspace } from '../src/main/team-secrets-service.js';

const REF = 'sec_0123456789abcdef0123456789';
const fakeCrypto = (available = true): CryptoBackend => ({
  available,
  encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
  decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
});

let base: string;
let tree: string;
let clock: number;

interface Machine {
  readonly name: string;
  readonly service: TeamSecretsService;
  readonly store: SecretStore;
  readonly ws: TeamSecretsWorkspace;
  readonly commits: string[];
  readonly requests: { keyId: string; content: string }[];
  uses: SecretUse[];
  role: 'viewer' | 'editor' | 'admin' | undefined;
}

function machine(
  name: string,
  options: {
    readonly kind?: TeamSecretsWorkspace['kind'];
    readonly role?: 'viewer' | 'editor' | 'admin';
    readonly available?: boolean;
    readonly memberEmails?: () => Promise<readonly string[] | undefined>;
  } = {},
): Machine {
  const store = new SecretStore(join(base, name), fakeCrypto(options.available ?? true));
  const m = {
    name,
    store,
    commits: [] as string[],
    requests: [] as { keyId: string; content: string }[],
    uses: [] as SecretUse[],
    role: options.role,
  } as Machine;
  const kind = options.kind ?? 'folder';
  const ws: TeamSecretsWorkspace = {
    workspaceId: 'ws-1',
    dir: join(base, name, 'workspace'),
    tree,
    kind,
    role: () => m.role,
    uses: () => m.uses,
    identity: () => Promise.resolve({ name, email: `${name.toLowerCase()}@example.test` }),
    beforeWrite: () => undefined,
    afterWrite: (message) => {
      m.commits.push(message);
    },
    ...(kind === 'server'
      ? {
          // What the route does on the server: one key file, committed for the requester.
          requestKey: async (keyId: string, content: string) => {
            m.requests.push({ keyId, content });
            await mkdir(join(tree, 'team-secrets', 'keys'), { recursive: true });
            await writeFile(join(tree, 'team-secrets', 'keys', `${keyId}.yaml`), content, 'utf8');
          },
        }
      : {}),
    ...(options.memberEmails !== undefined ? { memberEmails: options.memberEmails } : {}),
  };
  const service = new TeamSecretsService({
    store,
    machine: () => `${name.toLowerCase()}-laptop`,
    now: () => new Date((clock += 1000)),
  });
  service.attach(ws);
  Object.assign(m, { service, ws });
  return m;
}

/** Every file under the tree, as one string: what a search of the repository would see. */
async function treeText(): Promise<string> {
  const names = (await readdir(tree, { recursive: true })).map(String);
  const parts = await Promise.all(names.map((name) => readFile(join(tree, name), 'utf8').catch(() => '')));
  return parts.join('\n');
}

async function vaultEntry(ref = REF) {
  const text = await readFile(join(tree, ...vaultEntryPath(vaultEntryId({ ref })).split('/')), 'utf8');
  return parseTeamSecretsFile(vaultEntryFileSchema, text)!;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'wirebench-team-secrets-'));
  tree = join(base, 'tree');
  await mkdir(tree, { recursive: true });
  clock = Date.parse('2026-09-26T10:00:00.000Z');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A turns team secrets on holding `hunter2` for REF; B asks; A approves B. */
async function aliceAndBob(): Promise<{ a: Machine; b: Machine }> {
  const a = machine('Alice');
  await a.store.put(REF, 'hunter2', { label: 'Password' });
  a.uses = [{ secret: { ref: REF } }];
  await a.service.turnOn();
  const b = machine('Bob');
  b.uses = [{ secret: { ref: REF } }];
  await b.service.afterPull([]);
  const bobKey = (await b.service.status()).me.keyId!;
  await a.service.approve(bobKey);
  return { a, b };
}

describe('TeamSecretsService — turning on (§3.1)', () => {
  it('writes this machine’s key, a genesis naming it admin and every value it holds, in one commit', async () => {
    const a = machine('Alice');
    await a.store.put(REF, 'hunter2', { label: 'Password' });
    a.uses = [{ secret: { ref: REF } }];

    const status = await a.service.turnOn();

    expect(status).toMatchObject({
      on: true,
      authority: 'signed',
      canManage: true,
      me: { state: 'approved', admin: true },
    });
    expect(status.me.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(a.commits).toEqual(['Turn on team secrets']);
    const entry = await vaultEntry();
    expect(entry.label).toBe('Password');
    expect(Object.keys(entry.wraps)).toEqual([status.me.keyId]);
    expect(await treeText()).not.toContain('hunter2');
  });

  it('needs the keychain, and is a no-op once on', async () => {
    const noKeychain = machine('Nokey', { available: false });
    await expect(noKeychain.service.turnOn()).rejects.toMatchObject({ code: 'team-secrets-no-safe-storage' });
    expect((await noKeychain.service.status()).canTurnOn).toBe(false);

    const a = machine('Alice');
    await a.service.turnOn();
    await a.service.turnOn();
    expect(a.commits).toEqual(['Turn on team secrets']);
    // The workspace is on now; this machine still cannot make a key.
    expect(await noKeychain.service.status()).toMatchObject({
      me: { state: 'unavailable' },
      message: 'Team secrets need the system keychain, which is not available on this machine.',
    });
  });

  it('on a server share, only a server admin turns it on, with server authority', async () => {
    const editor = machine('Eve', { kind: 'server', role: 'editor' });
    await expect(editor.service.turnOn()).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
    expect((await editor.service.status()).canTurnOn).toBe(false);
    const admin = machine('Alice', { kind: 'server', role: 'admin' });
    expect(await admin.service.turnOn()).toMatchObject({ on: true, authority: 'server', canManage: true });
  });
});

describe('TeamSecretsService — joining and approval (§3.2)', () => {
  it('asks for access on the next sync and waits; the admin sees the request with its fingerprint', async () => {
    const a = machine('Alice');
    await a.service.turnOn();
    const b = machine('Bob');

    await b.service.afterPull([]);
    await b.service.afterPull([]);

    const mine = await b.service.status();
    expect(mine.me.state).toBe('pending');
    expect(b.commits).toEqual(['Request team secrets access for Bob']);
    const theirs = await a.service.status();
    expect(theirs.pending).toEqual([
      {
        keyId: mine.me.keyId,
        name: 'Bob',
        email: 'bob@example.test',
        machine: 'bob-laptop',
        fingerprint: mine.me.fingerprint,
        requestedAt: expect.any(String) as string,
        admin: false,
        mine: false,
      },
    ]);
  });

  it('approves in one commit that wraps every value for the new key', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    expect(a.commits.at(-1)).toBe('Approve team secrets access for Bob');
    expect(Object.keys((await vaultEntry()).wraps)).toContain(bobKey);
    expect((await b.service.status()).me.state).toBe('approved');
    expect((await a.service.status()).pending).toEqual([]);
  });

  it('refuses a non-admin’s approval, and declines by deleting the request', async () => {
    const { a, b } = await aliceAndBob();
    const c = machine('Carol');
    await c.service.afterPull([]);
    const carolKey = (await c.service.status()).me.keyId!;
    await expect(b.service.approve(carolKey)).rejects.toMatchObject({ code: 'team-secrets-admin-only' });

    await a.service.decline(carolKey);
    expect(a.commits.at(-1)).toBe('Decline team secrets access for Carol');
    expect(await readdir(join(tree, 'team-secrets', 'keys'))).not.toContain(`${carolKey}.yaml`);
  });

  it('on a server share, asks through the route and commits nothing itself', async () => {
    const a = machine('Alice', { kind: 'server', role: 'admin' });
    await a.service.turnOn();
    const v = machine('Vera', { kind: 'server', role: 'viewer' });
    await v.service.afterPull([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(v.requests).toHaveLength(1);
    expect(v.commits).toEqual([]);
    expect((await a.service.status()).pending.map((key) => key.name)).toEqual(['Vera']);
  });
});

describe('TeamSecretsService — removing and admins (§3.6, §3.7)', () => {
  it('re-encrypts every value without the removed key and marks each one it could read', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    const before = await vaultEntry();

    const status = await a.service.remove(bobKey);

    const after = await vaultEntry();
    expect(Object.keys(after.wraps)).not.toContain(bobKey);
    expect(after.cipher).not.toBe(before.cipher);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(a.commits.at(-1)).toBe('Remove Bob from team secrets');
    expect(status.rotate).toEqual([
      { entryId: vaultEntryId({ ref: REF }), label: 'Password', secret: { ref: REF }, removedNames: ['Bob'] },
    ]);
    expect(await b.service.status()).toMatchObject({
      me: { state: 'removed' },
      message: 'An admin removed this machine from team secrets.',
    });
  });

  it('never revokes or removes the last admin, and hands admin over when there is another', async () => {
    const { a, b } = await aliceAndBob();
    const aliceKey = (await a.service.status()).me.keyId!;
    const bobKey = (await b.service.status()).me.keyId!;
    await expect(a.service.revokeAdmin(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-last-admin' });
    await expect(a.service.remove(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-last-admin' });
    await a.service.grantAdmin(bobKey);
    await a.service.revokeAdmin(aliceKey);
    expect((await b.service.status()).canManage).toBe(true);
    expect((await a.service.status()).canManage).toBe(false);
  });

  it('lets a removed machine ask again with a fresh key', async () => {
    const { a, b } = await aliceAndBob();
    const old = (await b.service.status()).me.keyId!;
    await a.service.remove(old);
    const again = await b.service.requestAccess();
    expect(again.me.state).toBe('pending');
    expect(again.me.keyId).not.toBe(old);
  });
});

describe('TeamSecretsService — former members on a server share (§3.6)', () => {
  it('lists approved keys whose email has no role, and keeps the list when the server cannot answer', async () => {
    let members: readonly string[] | undefined = ['alice@example.test', 'vera@example.test'];
    const a = machine('Alice', { kind: 'server', role: 'admin', memberEmails: () => Promise.resolve(members) });
    await a.service.turnOn();
    const v = machine('Vera', { kind: 'server', role: 'viewer' });
    await v.service.afterPull([]);
    const veraKey = (await v.service.status()).me.keyId!;
    await a.service.approve(veraKey);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await a.service.status()).formerMembers).toEqual([]);

    members = ['alice@example.test'];
    await a.service.afterPull([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await a.service.status()).formerMembers).toEqual([veraKey]);

    // Offline or signed out: no answer, so nothing changes.
    members = undefined;
    await a.service.afterPull([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await a.service.status()).formerMembers).toEqual([veraKey]);
  });
});

describe('TeamSecretsService — what leaves main', () => {
  it('never answers with a value or a private key', async () => {
    const { a, b } = await aliceAndBob();
    const keyRef = await a.store.findByLabel('wirebench-team-key:ws-1');
    const privateKeys = JSON.parse((await a.store.get(keyRef!))!) as Record<string, string>;
    const answered = JSON.stringify([await a.service.status(), await b.service.status()]);
    expect(answered).not.toContain('hunter2');
    expect(answered).not.toContain(privateKeys['encryptionPrivate']);
    expect(answered).not.toContain(privateKeys['signingPrivate']);
    expect(await treeText()).not.toContain(privateKeys['signingPrivate']);
  });
});

describe('TeamSecretsService — a damaged access log (plan decision 4)', () => {
  const DAMAGED =
    'An access change is missing from this workspace. Restore it from the history before changing team secrets.';

  it('stops writing when an access entry it has seen is missing from the tree', async () => {
    const { a } = await aliceAndBob();
    const c = machine('Carol');
    await c.service.afterPull([]);
    const carolKey = (await c.service.status()).me.keyId!;
    const accessDir = join(tree, 'team-secrets', 'access');
    const entries = (await readdir(accessDir)).sort();
    await rm(join(accessDir, entries.at(-1)!));
    const commits = [...a.commits];

    expect(await a.service.status()).toMatchObject({ canManage: false, message: DAMAGED });
    await expect(a.service.approve(carolKey)).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
    expect(a.commits).toEqual(commits);
  });

  it('stops writing when an access entry it has seen is still there but the replay now rejects it', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    const c = machine('Carol');
    await c.service.afterPull([]);
    const carolKey = (await c.service.status()).me.keyId!;
    // The approval stays, but the key request it names is gone: the replay now rejects it.
    await rm(join(tree, 'team-secrets', 'keys', `${bobKey}.yaml`));
    const commits = [...a.commits];

    expect(await a.service.status()).toMatchObject({ canManage: false, message: DAMAGED });
    await expect(a.service.approve(carolKey)).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
    expect(a.commits).toEqual(commits);
  });

  it('stops writing when an access entry it has seen no longer verifies', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    const accessDir = join(tree, 'team-secrets', 'access');
    for (const name of await readdir(accessDir)) {
      const text = await readFile(join(accessDir, name), 'utf8');
      if (text.includes('action: approve')) {
        await writeFile(join(accessDir, name), text.replace(/at: .*/, 'at: 2020-01-01T00:00:00.000Z'), 'utf8');
      }
    }

    expect(await a.service.status()).toMatchObject({ canManage: false, message: DAMAGED });
    await expect(a.service.remove(bobKey)).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
  });
});
