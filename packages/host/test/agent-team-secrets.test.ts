// @vitest-environment node
/**
 * Team secrets for a paired tab's send on the desktop's agent (hosted edition spec §18.5): resolved from this
 * machine's own approved, imported values, for the server workspace whose origin is the pairing's, and
 * refused for an unapproved machine, another server's workspace of the same id, or a copy older than the
 * server's.
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkspace,
  DEFAULT_SYNC_SETTINGS,
  generateId,
  saveShare,
  saveWorkspace,
  workspaceDir,
  type SecretKey,
} from '@wirebench/engine';
import { agentTeamSecrets } from '../src/agent-team-secrets.js';
import { secretStoreLabel } from '../src/secret-resolver.js';
import { SecretStore, type CryptoBackend } from '../src/secrets.js';
import type { AgentTeamSecretQuery } from '../src/send/detached.js';
import { TeamSecretsService, type TeamSecretsWorkspace } from '../src/team-secrets-service.js';

const ORIGIN = 'https://wirebench.example.test';
const OTHER_ORIGIN = 'https://other.example.test';
const NAME = 'API_KEY';
const crypto: CryptoBackend = {
  available: true,
  encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
  decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
};

let base: string;
let clock: number;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'wirebench-agent-team-'));
  clock = Date.parse('2026-10-29T10:00:00.000Z');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Setup {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly tree: string;
  readonly bob: { readonly userData: string; readonly store: SecretStore; readonly service: TeamSecretsService };
  readonly alice: { readonly service: TeamSecretsService };
  readonly secret: SecretKey;
}

/**
 * Bob's desktop holds a server workspace from {@link ORIGIN}; Alice turns team secrets on in its tree with
 * `hunter2` for the project's `API_KEY`; Bob asks for access and, when `approve`, Alice approves and Bob
 * pulls (importing the value).
 */
async function setUp(options: {
  readonly approve: boolean;
  readonly origin?: string;
  readonly projectId?: string;
  readonly value?: string;
  /** Bob's machine store, when a second workspace is set up on the same machine. */
  readonly bobStore?: SecretStore;
  /** Tells two Alices (two servers' admins) apart. */
  readonly tag?: string;
}): Promise<Setup> {
  const projectId = options.projectId ?? generateId();
  const tag = options.tag ?? 'a';
  const workspace = {
    ...createWorkspace('Payments QA'),
    projects: [{ id: projectId, slug: 'payments', source: 'internal' as const }],
  };
  const bobUserData = join(base, 'bob');
  const dir = workspaceDir(bobUserData, workspace.id);
  const tree = join(dir, 'tree');
  await mkdir(tree, { recursive: true });
  await saveWorkspace(workspace, tree);
  await saveShare(dir, {
    version: 1,
    kind: 'server',
    server: { ...DEFAULT_SYNC_SETTINGS, url: options.origin ?? ORIGIN, workspaceId: workspace.id },
  });
  const secret: SecretKey = { token: { projectId, name: NAME } };
  const now = (): Date => new Date((clock += 1000));
  const wsOf = (wsDir: string, kind: TeamSecretsWorkspace['kind'], email: string): TeamSecretsWorkspace => ({
    workspaceId: workspace.id,
    dir: wsDir,
    tree,
    kind,
    role: () => 'admin',
    uses: () => [{ secret }],
    identity: () => Promise.resolve({ name: email, email }),
    beforeWrite: () => undefined,
    afterWrite: () => undefined,
  });

  const aliceStore = new SecretStore(join(base, `alice-${tag}`), crypto);
  await aliceStore.set(options.value ?? 'hunter2', { label: secretStoreLabel(projectId, NAME) });
  const alice = new TeamSecretsService({ store: aliceStore, machine: () => 'alice-laptop', now });
  alice.attach(wsOf(join(base, `alice-${tag}`, 'workspace'), 'folder', 'alice@example.test'));
  await alice.turnOn();

  const bobStore = options.bobStore ?? new SecretStore(join(bobUserData, 'secrets'), crypto);
  const bob = new TeamSecretsService({ store: bobStore, machine: () => 'bob-laptop', now });
  bob.attach(wsOf(dir, 'folder', 'bob@example.test'));
  await bob.afterPull([]);
  if (options.approve) {
    await alice.approve((await bob.status()).me.keyId!);
    await bob.afterPull([]);
  }
  return {
    workspaceId: workspace.id,
    projectId,
    tree,
    bob: { userData: bobUserData, store: bobStore, service: bob },
    alice: { service: alice },
    secret,
  };
}

/** The tree's `team-secrets/` subtree, as a bundle carries it. */
async function subtree(tree: string): Promise<Map<string, string>> {
  const root = join(tree, 'team-secrets');
  const files = new Map<string, string>();
  for (const name of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!name.isFile()) continue;
    const path = join(name.parentPath, name.name);
    files.set(relative(root, path).split(sep).join('/'), await readFile(path, 'utf8'));
  }
  return files;
}

async function query(setup: Setup, overrides: Partial<AgentTeamSecretQuery> = {}): Promise<AgentTeamSecretQuery> {
  return {
    pairingId: 'pairing-1',
    serverOrigin: ORIGIN,
    workspaceId: setup.workspaceId,
    projectId: setup.projectId,
    name: NAME,
    bundleTeamSecrets: await subtree(setup.tree),
    ...overrides,
  };
}

function resolverFor(setup: Setup) {
  return agentTeamSecrets({ userDataDir: setup.bob.userData, store: setup.bob.store, machine: () => 'bob-laptop' });
}

describe('team secrets on the desktop agent (§18.5)', () => {
  it('resolves the value this approved machine imported, for the workspace of the pairing’s origin', async () => {
    const setup = await setUp({ approve: true });
    await expect(resolverFor(setup)(await query(setup))).resolves.toBe('hunter2');
  });

  it('refuses another server’s workspace of the same id', async () => {
    const setup = await setUp({ approve: true });
    await expect(resolverFor(setup)(await query(setup, { serverOrigin: OTHER_ORIGIN }))).rejects.toMatchObject({
      code: 'team-secret-needs-approval',
    });
    await expect(resolverFor(setup)(await query(setup, { serverOrigin: OTHER_ORIGIN }))).rejects.toThrow(
      'Open the workspace from https://other.example.test',
    );
  });

  it('answers team-secret-needs-approval, naming the machine, when this machine is not approved', async () => {
    const setup = await setUp({ approve: false });
    await expect(resolverFor(setup)(await query(setup))).rejects.toMatchObject({
      code: 'team-secret-needs-approval',
      details: { machine: 'bob-laptop', workspaceId: setup.workspaceId },
    });
  });

  it('answers team-secret-stale when the server holds a newer value than this machine imported', async () => {
    const setup = await setUp({ approve: true });
    await setup.alice.service.recordValue(setup.secret, NAME, 'rotated');
    await expect(resolverFor(setup)(await query(setup))).rejects.toMatchObject({ code: 'team-secret-stale' });
    // Once this machine syncs, the new value resolves.
    await setup.bob.service.afterPull([]);
    await expect(resolverFor(setup)(await query(setup))).resolves.toBe('rotated');
  });

  it('gives each server its own workspace’s value when two workspaces share a project id and name', async () => {
    const projectId = generateId();
    const a = await setUp({ approve: true, projectId, value: 'value-of-a' });
    const b = await setUp({
      approve: true,
      projectId,
      value: 'value-of-b',
      origin: OTHER_ORIGIN,
      bobStore: a.bob.store,
      tag: 'b',
    });
    // Both imports wrote the one store label; the last (B's) holds it.
    const ref = await a.bob.store.findByLabel(secretStoreLabel(projectId, NAME));
    expect(await a.bob.store.get(ref!)).toBe('value-of-b');
    const resolve = resolverFor(a);
    await expect(resolve(await query(a))).resolves.toBe('value-of-a');
    await expect(resolve(await query(b, { serverOrigin: OTHER_ORIGIN }))).resolves.toBe('value-of-b');
  });

  it('asks to open the workspace only for a name the server’s vault holds', async () => {
    const setup = await setUp({ approve: true });
    const resolve = resolverFor(setup);
    // Another server, whose bundle's subtree does not hold the name: plainly missing.
    await expect(
      resolve(await query(setup, { serverOrigin: OTHER_ORIGIN, bundleTeamSecrets: new Map() })),
    ).resolves.toBeUndefined();
  });

  it('treats an import time that does not parse as stale', async () => {
    const setup = await setUp({ approve: true });
    const files = await query(setup);
    const [path, text] = [...files.bundleTeamSecrets].find(([one]) => one.startsWith('values/'))!;
    const broken = new Map(files.bundleTeamSecrets).set(path, text.replace(/updatedAt: .*/, 'updatedAt: not-a-time'));
    // A server copy whose time does not parse is not proof of anything current.
    await expect(resolverFor(setup)({ ...files, bundleTeamSecrets: broken })).rejects.toMatchObject({
      code: 'team-secret-stale',
    });
  });

  it('says a tampered access log is damaged, not stale', async () => {
    const setup = await setUp({ approve: true });
    const access = join(setup.tree, 'team-secrets', 'access');
    for (const name of await readdir(access)) await rm(join(access, name));
    await expect(resolverFor(setup)(await query(setup))).rejects.toMatchObject({ code: 'team-secrets-damaged' });
  });

  it('answers nothing for a name that is not a team secret, or a project outside the workspace', async () => {
    const setup = await setUp({ approve: true });
    const resolve = resolverFor(setup);
    await expect(resolve(await query(setup, { name: 'OTHER' }))).resolves.toBeUndefined();
    await expect(resolve(await query(setup, { projectId: generateId() }))).resolves.toBeUndefined();
    await expect(resolve(await query(setup, { projectId: undefined }))).resolves.toBeUndefined();
  });
});
