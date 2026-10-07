// @vitest-environment node
/**
 * Team secrets through a real shared git workspace: two app-data roots ("machines") on one bare
 * remote, each with its own keychain-backed store (fake crypto) and team-secrets service.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  DEFAULT_GIT_SHARE_SETTINGS,
  saveShare,
  saveWorkspace,
  vaultEntryId,
  vaultEntryPath,
  workspaceDir,
} from '@wirebench/engine';
import type { GitCli, Workspace } from '@wirebench/engine';
import type { WebContents } from 'electron';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { SecretStore } from '../src/main/secrets.js';
import { GitBackend } from '../src/main/sync/git-backend.js';
import type { SyncConflictWire } from '../src/main/sync/types.js';
import { TeamSecretStore } from '../src/main/team-secret-store.js';
import { TEAM_SECRETS_LOCAL_FILE, TeamSecretsService } from '../src/main/team-secrets-service.js';
import type { TeamSecretsServiceDeps } from '../src/main/team-secrets-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';
import {
  createBareRemote,
  describeGit,
  hermeticGitEnv,
  makeTestGitCli,
  mkTempDir,
  removeTempDir,
  setTestIdentity,
} from './sync/git-fixture.js';

const WAIT = { timeout: 20_000, interval: 50 };
/** The ref the seeded workspace's `password` property names: a secret the workspace uses, so it is shared. */
const PASSWORD_REF = 'sec_0123456789abcdef0123456789';

interface Machine {
  readonly service: WorkspaceService;
  readonly team: TeamSecretsService;
  readonly store: SecretStore;
  /** What the renderer's `secrets.*` channels write through. */
  readonly secrets: TeamSecretStore;
  readonly conflicts: SyncConflictWire[][];
  /** The shared tree (a git work tree). */
  readonly tree: string;
}

let base: string;
let git: GitCli;
let remoteUrl: string;
let workspace: Workspace;
const machines: Machine[] = [];
/** Services opened without a whole `Machine`, closed after each test too. */
const services: WorkspaceService[] = [];

function share(): Parameters<typeof saveShare>[1] {
  return { version: 1, kind: 'git', git: { ...DEFAULT_GIT_SHARE_SETTINGS, remote: remoteUrl, autoFetchSeconds: 0 } };
}

async function seedShared(): Promise<string> {
  const root = join(base, 'a');
  workspace = { ...createWorkspace('Team'), properties: { password: PASSWORD_REF } };
  const dir = workspaceDir(root, workspace.id);
  const tree = join(dir, 'tree');
  await mkdir(tree, { recursive: true });
  await GitBackend.init(git, tree, 'main');
  await setTestIdentity(git, tree);
  await saveWorkspace(workspace, tree);
  await saveShare(dir, share());
  await git.run(tree, ['remote', 'add', 'origin', remoteUrl]);
  await git.run(tree, ['add', '-A', '--', '.']);
  await git.run(tree, ['commit', '-m', 'Share workspace']);
  await git.run(tree, ['push', 'origin', 'HEAD:refs/heads/main']);
  return root;
}

async function cloneTo(name: string): Promise<string> {
  const root = join(base, name);
  const dir = workspaceDir(root, workspace.id);
  await mkdir(dir, { recursive: true });
  await GitBackend.clone(git, remoteUrl, 'main', join(dir, 'tree'));
  await setTestIdentity(git, join(dir, 'tree'), 'Bob', 'bob@example.com');
  await saveShare(dir, share());
  return root;
}

function fakeKeychain(root: string): SecretStore {
  return new SecretStore(join(root, 'secrets'), {
    available: true,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  });
}

async function openMachine(root: string, teamDeps: Partial<TeamSecretsServiceDeps> = {}): Promise<Machine> {
  const store = fakeKeychain(root);
  const team = new TeamSecretsService({ store, machine: () => root, ...teamDeps });
  const conflicts: SyncConflictWire[][] = [];
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    watchDebounceMs: 30,
    git: () => Promise.resolve(git),
    teamSecrets: team,
    hooks: { onSyncConflict: (_id, list) => conflicts.push([...list]) },
  });
  const machine: Machine = {
    service,
    team,
    store,
    secrets: new TeamSecretStore(store, team),
    conflicts,
    tree: join(workspaceDir(root, workspace.id), 'tree'),
  };
  machines.push(machine);
  await service.open(workspace.id);
  await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);
  await service.sync()?.idle();
  return machine;
}

async function latestSubject(m: Machine): Promise<string | undefined> {
  return (await m.service.sync()?.log(1))?.[0]?.subject;
}

/**
 * Saves the workspace's Password through what the renderer's `secrets.*` channels write through (only a secret
 * the workspace uses reaches the vault).
 */
async function setPassword(m: Machine, value: string): Promise<string> {
  if (!(await m.store.exists(PASSWORD_REF))) {
    await m.store.put(PASSWORD_REF, value, { label: 'Password' });
  }
  await m.secrets.replace(PASSWORD_REF, value);
  return PASSWORD_REF;
}

/** Waits for `subject` to be the newest commit, then pushes it. */
async function committed(m: Machine, subject: string): Promise<void> {
  await vi.waitFor(async () => expect(await latestSubject(m)).toBe(subject), WAIT);
  await m.service.sync()?.push();
}

async function treeGit(tree: string, args: readonly string[]): Promise<string> {
  return (await git.run(tree, [...args])).stdout.trim();
}

/** Gives every repository under test a commit identity through the hermetic global config. */
async function globalIdentity(name: string, email: string): Promise<void> {
  await writeFile(join(base, '.gitconfig-test'), `[user]\n\tname = ${name}\n\temail = ${email}\n`, 'utf8');
}

/** A machine turned on by A, with B's key approved and the approval pulled. */
async function twoApproved(): Promise<{ a: Machine; b: Machine }> {
  const a = await openMachine(await seedShared());
  await a.team.turnOn();
  await committed(a, 'Turn on team secrets');
  const b = await openMachine(await cloneTo('b'));
  await committed(b, 'Request team secrets access for Bob');
  await a.service.sync()?.pull();
  await vi.waitFor(async () => expect((await a.team.status()).pending).toHaveLength(1), WAIT);
  await a.team.approve((await a.team.status()).pending[0]!.keyId);
  await committed(a, 'Approve team secrets access for Bob');
  return { a, b };
}

beforeEach(async () => {
  base = await mkTempDir('wirebench-team-secrets-');
  const hooksDir = join(base, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  git = makeTestGitCli(hooksDir, await hermeticGitEnv(base));
  ({ url: remoteUrl } = await createBareRemote(git, join(base, 'remote.git')));
});

afterEach(async () => {
  for (const service of [...machines.splice(0).map((machine) => machine.service), ...services.splice(0)]) {
    await service.close();
  }
  await removeTempDir(base);
});

it('leaves a local workspace alone (§13.6)', async () => {
  const root = join(base, 'local');
  const team = {
    attach: vi.fn(),
    detach: vi.fn(() => Promise.resolve()),
    turnOn: vi.fn(),
    turnOnIfAdmin: vi.fn(),
    afterPull: vi.fn(),
    resolveConflicts: vi.fn(),
    backfill: vi.fn(() => Promise.resolve()),
  };
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    teamSecrets: team,
  });
  await service.create('Solo');
  await service.close();
  expect(team.attach).not.toHaveBeenCalled();
  expect(team.turnOn).not.toHaveBeenCalled();
  expect(team.afterPull).not.toHaveBeenCalled();
});

describeGit('WorkspaceService — team secrets over git', { timeout: 90_000 }, () => {
  it('turns on, asks, approves and delivers a value to the second machine', async () => {
    const a = await openMachine(await seedShared());
    await a.team.turnOn();
    await committed(a, 'Turn on team secrets');
    const ref = await setPassword(a, 'hunter2');
    await committed(a, 'Update secret Password');

    const b = await openMachine(await cloneTo('b'));
    await committed(b, 'Request team secrets access for Bob');

    await a.service.sync()?.pull();
    await vi.waitFor(async () => expect((await a.team.status()).pending).toHaveLength(1), WAIT);
    await a.team.approve((await a.team.status()).pending[0]!.keyId);
    await committed(a, 'Approve team secrets access for Bob');

    await b.service.sync()?.pull();
    await vi.waitFor(async () => expect(await b.store.get(ref)).toBe('hunter2'), WAIT);
    expect((await b.team.status()).me.state).toBe('approved');
  });

  it('settles two machines setting one value without a conflict dialog: the newer value wins', async () => {
    const a = await openMachine(await seedShared());
    await a.team.turnOn();
    await committed(a, 'Turn on team secrets');
    const ref = await setPassword(a, 'hunter2');
    await committed(a, 'Update secret Password');
    const b = await openMachine(await cloneTo('b'));
    await committed(b, 'Request team secrets access for Bob');
    await a.service.sync()?.pull();
    await vi.waitFor(async () => expect((await a.team.status()).pending).toHaveLength(1), WAIT);
    await a.team.approve((await a.team.status()).pending[0]!.keyId);
    await committed(a, 'Approve team secrets access for Bob');
    await b.service.sync()?.pull();
    await vi.waitFor(async () => expect(await b.store.get(ref)).toBe('hunter2'), WAIT);

    await a.secrets.replace(ref, 'from-a');
    await committed(a, 'Update secret Password');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = await treeGit(b.tree, ['rev-parse', 'HEAD']);
    await b.secrets.replace(ref, 'from-b');
    // B's write commits and pushes at once; A's newer remote rejects that push, so B merges the two
    // vault edits there before pushing again: B's own commit, then a merge on top of it.
    await vi.waitFor(
      async () =>
        expect(await treeGit(b.tree, ['log', '--format=%an %s', `${before}..HEAD`])).toContain(
          'Bob Update secret Password',
        ),
      WAIT,
    );
    await b.service.sync()?.idle();
    expect((await treeGit(b.tree, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ')).toHaveLength(3);

    await b.service.sync()?.pull();

    expect(b.conflicts.flat().map((conflict) => conflict.path)).not.toContain(vaultEntryPath(vaultEntryId({ ref })));
    expect(b.service.sync()?.status().state).not.toBe('conflict');
    expect(await b.store.get(ref)).toBe('from-b');
    await b.service.sync()?.push();
    await a.service.sync()?.pull();
    await vi.waitFor(async () => expect(await a.store.get(ref)).toBe('from-b'), WAIT);
  });

  it("does not report the app's own vault write as an outside edit (#289)", async () => {
    const a = await openMachine(await seedShared());
    await a.team.turnOn();
    await committed(a, 'Turn on team secrets');
    await a.service.sync()?.idle();
    const afterPull = vi.spyOn(a.team, 'afterPull');

    await setPassword(a, 'hunter2');
    await committed(a, 'Update secret Password');
    // Well past the watcher's debounce: a mismatched self-write event would have been reported by now.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(afterPull).not.toHaveBeenCalled();
  });

  it("hands a pull's vault change to team secrets once, from the pull and not from the watcher", async () => {
    const { b } = await twoApproved();
    const afterPull = vi.spyOn(b.team, 'afterPull');

    await b.service.sync()?.pull();
    await b.service.sync()?.idle();
    // Well past the watcher's debounce: a late report of the merge's writes would have arrived by now.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await b.service.sync()?.idle();

    expect(afterPull).toHaveBeenCalledTimes(1);
    expect(afterPull.mock.calls[0]![0].length).toBeGreaterThan(0);
    expect(afterPull.mock.calls[0]![0].every((path) => path.startsWith('team-secrets/'))).toBe(true);
    expect((await b.team.status()).me.state).toBe('approved');
  });

  it('never lets a failing pull hook break the pull or go unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const a = await openMachine(await seedShared());
      await a.team.turnOn();
      await committed(a, 'Turn on team secrets');
      const root = await cloneTo('b');
      const team = {
        attach: vi.fn(),
        detach: vi.fn(() => Promise.resolve()),
        turnOn: vi.fn(),
        turnOnIfAdmin: vi.fn(),
        afterPull: vi.fn(() => Promise.reject(new Error('boom'))),
        resolveConflicts: vi.fn(() => Promise.resolve(new Map<string, 'mine' | 'theirs'>())),
        backfill: vi.fn(() => Promise.resolve()),
      };
      const service = new WorkspaceService({
        userDataDir: root,
        engine: new EngineService(),
        history: new HistoryService(root),
        watchDebounceMs: 30,
        git: () => Promise.resolve(git),
        teamSecrets: team,
      });
      services.push(service);
      await service.open(workspace.id);
      await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);
      await service.sync()?.idle();
      await setPassword(a, 'hunter2');
      await committed(a, 'Update secret Password');

      await expect(service.sync()?.pull()).resolves.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(team.afterPull).toHaveBeenCalledWith(expect.arrayContaining([expect.stringMatching(/^team-secrets\//)]));
      expect(service.sync()?.status().state).toBe('clean');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('lets a team-secrets write still in flight commit under its own message when the workspace closes', async () => {
    const a = await openMachine(await seedShared());
    await a.team.turnOn();
    await committed(a, 'Turn on team secrets');

    // Close once the vault write is running in team secrets (its first read of the vault), before it writes
    // and hands its commit to sync.
    const inner = a.team as unknown as { load: (...args: unknown[]) => Promise<unknown> };
    const load = inner.load.bind(a.team);
    let closed: Promise<unknown> | undefined;
    vi.spyOn(inner, 'load').mockImplementation((...args) => {
      closed ??= a.service.close();
      return load(...args);
    });
    await setPassword(a, 'hunter2');
    await closed;

    expect(await treeGit(a.tree, ['log', '-1', '--format=%s'])).toBe('Update secret Password');
    expect(await treeGit(a.tree, ['status', '--porcelain'])).toBe('');
  });

  it('keeps the pull hook from throwing when showing the status fails', async () => {
    const a = await openMachine(await seedShared(), {
      onChanged: () => {
        throw new Error('window gone');
      },
    });

    await expect(a.team.afterPull([])).resolves.toBeUndefined();
    await expect(a.service.sync()?.pull()).resolves.toBeDefined();
  });
});

describeGit('WorkspaceService — sharing turns team secrets on', { timeout: 60_000 }, () => {
  async function localMachine(
    overrides: Partial<WorkspaceServiceDeps> = {},
  ): Promise<{ service: WorkspaceService; team: TeamSecretsService; dir: string }> {
    const root = join(base, 'solo');
    await mkdir(root, { recursive: true });
    const team = new TeamSecretsService({
      store: fakeKeychain(root),
      machine: () => 'laptop',
      osUser: () => 'os-person',
    });
    const service = new WorkspaceService({
      userDataDir: root,
      engine: new EngineService(),
      history: new HistoryService(root),
      watchDebounceMs: 30,
      git: () => Promise.resolve(git),
      picks: new DialogPicks(),
      teamSecrets: team,
      ...overrides,
    });
    services.push(service);
    const created = await service.create('Team');
    return { service, team, dir: workspaceDir(root, created.id) };
  }

  it("turns on inside a git share's first commit, named after the tree's git identity; stop sharing keeps the vault", async () => {
    await globalIdentity('Alice', 'alice@example.com');
    const { service, team, dir } = await localMachine();

    await service.share({});
    await service.sync()?.idle();

    const tree = join(dir, 'tree');
    const [first] = (await treeGit(tree, ['rev-list', '--max-parents=0', 'HEAD'])).split('\n');
    expect(await treeGit(tree, ['log', '-1', '--format=%s', first!])).toBe('Share workspace Team');
    expect(await treeGit(tree, ['show', '--name-only', '--format=', first!])).toMatch(/^team-secrets\//m);
    const status = await team.status();
    expect(status.on).toBe(true);
    expect(status.approved.map((key) => [key.name, key.email])).toEqual([['Alice', 'alice@example.com']]);

    await service.stopSharing();

    expect(existsSync(join(tree, 'team-secrets'))).toBe(true);
    expect(existsSync(join(dir, 'team-secrets'))).toBe(false);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
  });

  it('turns team secrets on again when a workspace is shared, stopped and shared again (I2)', async () => {
    await globalIdentity('Alice', 'alice@example.com');
    const target = join(base, 'synced-again');
    await mkdir(target);
    const { service, team, dir } = await localMachine({
      dialogs: { pickFolder: () => Promise.resolve(target), pickFolderToWrite: () => Promise.resolve(target) },
    });
    await service.share({});
    await service.sync()?.idle();
    expect((await team.status()).on).toBe(true);

    await service.stopSharing();
    expect(existsSync(join(dir, TEAM_SECRETS_LOCAL_FILE))).toBe(false);

    // Shared again somewhere new: the old share's pins would read the new log as damaged.
    await service.shareToFolder({} as WebContents);

    await vi.waitFor(async () => expect((await team.status()).on).toBe(true), WAIT);
    const status = await team.status();
    expect(status).toMatchObject({ canManage: true, me: { state: 'approved' } });
    expect(status.message).toBeUndefined();
    expect(existsSync(join(target, 'team-secrets'))).toBe(true);
  });

  it('turns on in a folder share, named after the OS user when the folder is no git repository', async () => {
    await globalIdentity('Alice', 'alice@example.com');
    const target = join(base, 'synced');
    await mkdir(target);
    const { service, team } = await localMachine({
      dialogs: { pickFolder: () => Promise.resolve(target), pickFolderToWrite: () => Promise.resolve(target) },
    });

    await service.shareToFolder({} as WebContents);

    await vi.waitFor(async () => expect((await team.status()).on).toBe(true), WAIT);
    expect(existsSync(join(target, 'team-secrets'))).toBe(true);
    expect((await team.status()).approved.map((key) => key.name)).toEqual(['os-person']);
  });
});
