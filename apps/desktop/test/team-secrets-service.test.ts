// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accessEntryFileSchema,
  accessEntryPath,
  buildVaultEntry,
  decryptValue,
  GIT_ATTRIBUTES,
  nextAccessEntryId,
  parseMachineKeys,
  parseTeamSecretsFile,
  signDocument,
  teamSecretsFileText,
  unwrapDataKey,
  vaultEntryFileSchema,
  vaultEntryId,
  vaultEntryPath,
  verifiedKeys,
  readTeamSecretsFiles,
  type MachineKeys,
} from '@wirebench/engine';
import { SecretStore, TEAM_REPLACED_LABEL_PREFIX, type CryptoBackend } from '../src/main/secrets.js';
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
    const privateKeys = JSON.parse((await a.store.getMachineOnly(keyRef!))!) as Record<string, string>;
    const answered = JSON.stringify([await a.service.status(), await b.service.status()]);
    expect(answered).not.toContain('hunter2');
    expect(answered).not.toContain(privateKeys['encryptionPrivate']);
    expect(answered).not.toContain(privateKeys['signingPrivate']);
    expect(await treeText()).not.toContain(privateKeys['signingPrivate']);
  });
});

/** This machine's key pair, as the service keeps it (test-only: a real answer never carries it). */
async function keysOf(m: Machine): Promise<MachineKeys> {
  const ref = await m.store.findByLabel('wirebench-team-key:ws-1');
  return parseMachineKeys((await m.store.getMachineOnly(ref!))!)!;
}

async function accessEntries() {
  const dir = join(tree, 'team-secrets', 'access');
  const names = (await readdir(dir)).sort();
  return Promise.all(
    names.map(async (name) => parseTeamSecretsFile(accessEntryFileSchema, await readFile(join(dir, name), 'utf8'))!),
  );
}

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
    await expect(a.service.approve(carolKey)).rejects.toMatchObject({ code: 'team-secrets-damaged' });
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
    await expect(a.service.remove(bobKey)).rejects.toMatchObject({ code: 'team-secrets-damaged' });
  });

  it('stops writing when the key request of a seen entry’s signer is gone', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    await a.service.grantAdmin(bobKey);
    const c = machine('Carol');
    await c.service.afterPull([]);
    const carolKey = (await c.service.status()).me.keyId!;
    await b.service.approve(carolKey); // signed by Bob; Alice sees it next
    await a.service.status();
    await rm(join(tree, 'team-secrets', 'keys', `${bobKey}.yaml`));

    expect(await a.service.status()).toMatchObject({ canManage: false, message: DAMAGED });
  });

  it('does not count a seen entry whose subject’s request is gone (a concurrent decline) as damage', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    const c = machine('Carol');
    await c.service.afterPull([]);
    const carolKey = (await c.service.status()).me.keyId!;
    await rm(join(tree, 'team-secrets', 'keys', `${bobKey}.yaml`));

    const status = await a.service.status();
    expect(status.message).toBeUndefined();
    expect(status.canManage).toBe(true);
    expect(status.approved.map((key) => key.name)).toEqual(['Alice']);
    await a.service.approve(carolKey);
    expect(a.commits.at(-1)).toBe('Approve team secrets access for Carol');
  });

  it('merges two logs with concurrent admin changes without damage: the later entry just stops counting', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    await a.service.grantAdmin(bobKey);
    const grant = (await accessEntries()).at(-1)!;
    const c = machine('Carol');
    await c.service.afterPull([]);
    const carolKey = (await c.service.status()).me.keyId!;
    // Bob approves Carol; meanwhile, on another clone, Alice revoked Bob's admin just after the grant.
    await b.service.approve(carolKey);
    expect((await b.service.status()).approved.map((key) => key.name).sort()).toEqual(['Alice', 'Bob', 'Carol']);
    const revoke = signDocument(
      {
        version: 1 as const,
        id: nextAccessEntryId([grant.id], Date.parse(grant.at)),
        action: 'revoke-admin' as const,
        key: bobKey,
        by: grant.by,
        at: new Date(Date.parse(grant.at) + 1).toISOString(),
      },
      await keysOf(a),
    );
    await writeFile(join(tree, ...accessEntryPath(revoke.id).split('/')), teamSecretsFileText(revoke), 'utf8');

    for (const m of [a, b]) {
      const status = await m.service.status();
      expect(status.message).toBeUndefined();
      expect(status.approved.map((key) => key.name).sort()).toEqual(['Alice', 'Bob']);
    }
    expect((await b.service.status()).canManage).toBe(false);
    expect((await a.service.status()).canManage).toBe(true);
  });
});

describe('TeamSecretsService — refusals before writing', () => {
  it('refuses removing this machine’s own key, with two admins (signed)', async () => {
    const { a, b } = await aliceAndBob();
    const aliceKey = (await a.service.status()).me.keyId!;
    await a.service.grantAdmin((await b.service.status()).me.keyId!);
    const commits = [...a.commits];
    await expect(a.service.remove(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-remove-self' });
    expect(a.commits).toEqual(commits);
  });

  it('refuses removing its own key on a server share, and the last approved key', async () => {
    const a = machine('Alice', { kind: 'server', role: 'admin' });
    await a.service.turnOn();
    const aliceKey = (await a.service.status()).me.keyId!;
    await expect(a.service.remove(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-last-approved' });
    const v = machine('Vera', { kind: 'server', role: 'viewer' });
    await v.service.afterPull([]);
    await a.service.approve((await v.service.status()).me.keyId!);
    await expect(a.service.remove(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-remove-self' });
  });

  it('refuses a removal when a value is not readable here, naming its label', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    const bob = await keysOf(b);
    const secret = { ref: 'sec_abcdefabcdefabcdefabcdefab' };
    const files = readTeamSecretsFiles(
      new Map([
        [
          `team-secrets/keys/${bobKey}.yaml`,
          await readFile(join(tree, 'team-secrets', 'keys', `${bobKey}.yaml`), 'utf8'),
        ],
      ]),
    );
    const onlyBob = buildVaultEntry({
      secret,
      label: 'Token',
      value: 'tok-bob',
      recipients: [...verifiedKeys(files.keys).values()],
      signer: bob,
      at: new Date(clock).toISOString(),
    });
    await writeFile(
      join(tree, ...vaultEntryPath(vaultEntryId(secret)).split('/')),
      teamSecretsFileText(onlyBob),
      'utf8',
    );
    const commits = [...a.commits];

    await expect(a.service.remove(bobKey)).rejects.toMatchObject({
      code: 'team-secrets-cannot-reencrypt',
      details: { labels: ['Token'] },
    });
    expect(a.commits).toEqual(commits);
  });

  it('refuses granting admin to an admin and revoking it from a non-admin', async () => {
    const { a, b } = await aliceAndBob();
    const aliceKey = (await a.service.status()).me.keyId!;
    const bobKey = (await b.service.status()).me.keyId!;
    await expect(a.service.grantAdmin(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-already-admin' });
    await expect(a.service.revokeAdmin(bobKey)).rejects.toMatchObject({ code: 'team-secrets-not-admin' });
  });

  it('tells a machine waiting for approval that it is pending', async () => {
    const a = machine('Alice');
    await a.service.turnOn();
    const b = machine('Bob');
    await b.service.afterPull([]);
    const aliceKey = (await a.service.status()).me.keyId!;
    await expect(b.service.remove(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-pending' });
  });

  it('asks for the keychain before asking for access again', async () => {
    const a = machine('Alice');
    await a.service.turnOn();
    const noKeychain = machine('Nokey', { available: false });
    await expect(noKeychain.service.requestAccess()).rejects.toMatchObject({ code: 'team-secrets-no-safe-storage' });
  });
});

describe('TeamSecretsService — server authority', () => {
  it('lets a server admin approve and remove, and refuses an approved editor', async () => {
    const a = machine('Alice', { kind: 'server', role: 'admin' });
    await a.store.put(REF, 'hunter2', { label: 'Password' });
    a.uses = [{ secret: { ref: REF } }];
    await a.service.turnOn();
    const e = machine('Eve', { kind: 'server', role: 'editor' });
    await e.service.afterPull([]);
    const eveKey = (await e.service.status()).me.keyId!;
    await a.service.approve(eveKey);
    const v = machine('Vera', { kind: 'server', role: 'viewer' });
    await v.service.afterPull([]);
    const veraKey = (await v.service.status()).me.keyId!;

    expect(await e.service.status()).toMatchObject({ me: { state: 'approved' }, canManage: false });
    await expect(e.service.approve(veraKey)).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
    await expect(e.service.grantAdmin(veraKey)).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
    await expect(a.service.grantAdmin(eveKey)).rejects.toMatchObject({ code: 'team-secrets-server-authority' });

    await a.service.approve(veraKey);
    await a.service.remove(eveKey);
    expect((await a.service.status()).approved.map((key) => key.name).sort()).toEqual(['Alice', 'Vera']);
    const wraps = Object.keys((await vaultEntry()).wraps);
    expect(wraps).toContain(veraKey);
    expect(wraps).not.toContain(eveKey);
  });
});

describe('TeamSecretsService — the data key after a removal', () => {
  it('seals the value under a data key the old wrap cannot open', async () => {
    const { a, b } = await aliceAndBob();
    const alice = await keysOf(a);
    const before = await vaultEntry();
    await a.service.remove((await b.service.status()).me.keyId!);
    const after = await vaultEntry();

    const oldKey = unwrapDataKey(before.wraps[alice.keyId]!, alice);
    const id = vaultEntryId({ ref: REF });
    expect(decryptValue(before.cipher, oldKey, id)).toBe('hunter2');
    expect(() => decryptValue(after.cipher, oldKey, id)).toThrow();
    expect(decryptValue(after.cipher, unwrapDataKey(after.wraps[alice.keyId]!, alice), id)).toBe('hunter2');
  });
});

describe('TeamSecretsService — .gitattributes on a git share', () => {
  it('writes it when missing and appends the vault line to an existing one', async () => {
    const a = machine('Alice', { kind: 'git' });
    await a.service.turnOn();
    expect(await readFile(join(tree, '.gitattributes'), 'utf8')).toBe(GIT_ATTRIBUTES);

    await rm(base, { recursive: true, force: true });
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, '.gitattributes'), '* text=auto', 'utf8');
    const b = machine('Bob', { kind: 'git' });
    await b.service.turnOn();
    expect(await readFile(join(tree, '.gitattributes'), 'utf8')).toBe('* text=auto\nteam-secrets/values/** -merge\n');
  });
});

describe('TeamSecretsService — machine-only store entries', () => {
  it('never puts a kept replaced value or a machine key into the vault or the local-only list', async () => {
    const a = machine('Alice');
    const kept = 'sec_ffffffffffffffffffffffffff';
    await a.store.put(kept, 'lost-value', { label: `${TEAM_REPLACED_LABEL_PREFIX}X` });
    a.uses = [{ secret: { ref: kept } }];
    expect((await a.service.status()).localOnly).toEqual([]);
    await a.service.turnOn();
    const keyRef = (await a.store.findByLabel('wirebench-team-key:ws-1'))!;
    a.uses = [{ secret: { ref: kept } }, { secret: { ref: keyRef } }];
    await a.service.afterPull([]);
    expect(await treeText()).not.toContain('lost-value');
    await expect(vaultEntry(kept)).rejects.toThrow();
    await expect(vaultEntry(keyRef)).rejects.toThrow();
  });
});

describe('TeamSecretsService — the send cache', () => {
  class Probe extends TeamSecretsService {
    cacheNow() {
      return this.cache;
    }
    loadFor(ws: TeamSecretsWorkspace) {
      return this.load(ws);
    }
  }

  it('is not overwritten by a load for a workspace that is no longer attached', async () => {
    const a = machine('Alice');
    await a.service.turnOn();
    const probe = new Probe({ store: a.store, now: () => new Date((clock += 1000)) });
    probe.attach(a.ws);
    await probe.loadFor(a.ws);
    expect(probe.cacheNow().on).toBe(true);

    const other: TeamSecretsWorkspace = { ...a.ws, workspaceId: 'ws-2', tree: join(base, 'other-tree') };
    probe.attach(other);
    await probe.loadFor(a.ws);
    expect(probe.cacheNow()).toMatchObject({ on: false, approved: false });
  });
});
