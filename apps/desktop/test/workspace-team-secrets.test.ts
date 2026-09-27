// @vitest-environment node
/**
 * Team secrets through a real shared git workspace: two app-data roots ("machines") on one bare
 * remote, each with its own keychain-backed store (fake crypto) and team-secrets service.
 */
import { mkdir } from 'node:fs/promises';
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
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { SecretStore } from '../src/main/secrets.js';
import { GitBackend } from '../src/main/sync/git-backend.js';
import type { SyncConflictWire } from '../src/main/sync/types.js';
import { TeamSecretStore } from '../src/main/team-secret-store.js';
import { TeamSecretsService } from '../src/main/team-secrets-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
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

interface Machine {
  readonly service: WorkspaceService;
  readonly team: TeamSecretsService;
  readonly store: SecretStore;
  /** What the renderer's `secrets.*` channels write through. */
  readonly secrets: TeamSecretStore;
  readonly conflicts: SyncConflictWire[][];
}

let base: string;
let git: GitCli;
let remoteUrl: string;
let workspace: Workspace;
const machines: Machine[] = [];

function share(): Parameters<typeof saveShare>[1] {
  return { version: 1, kind: 'git', git: { ...DEFAULT_GIT_SHARE_SETTINGS, remote: remoteUrl, autoFetchSeconds: 0 } };
}

async function seedShared(): Promise<string> {
  const root = join(base, 'a');
  workspace = createWorkspace('Team');
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

async function openMachine(root: string): Promise<Machine> {
  const store = new SecretStore(join(root, 'secrets'), {
    available: true,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  });
  const team = new TeamSecretsService({ store, machine: () => root });
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
  const machine: Machine = { service, team, store, secrets: new TeamSecretStore(store, team), conflicts };
  machines.push(machine);
  await service.open(workspace.id);
  await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);
  await service.sync()?.idle();
  return machine;
}

async function latestSubject(m: Machine): Promise<string | undefined> {
  return (await m.service.sync()?.log(1))?.[0]?.subject;
}

/** Waits for `subject` to be the newest commit, then pushes it. */
async function committed(m: Machine, subject: string): Promise<void> {
  await vi.waitFor(async () => expect(await latestSubject(m)).toBe(subject), WAIT);
  await m.service.sync()?.push();
}

beforeEach(async () => {
  base = await mkTempDir('wirebench-team-secrets-');
  const hooksDir = join(base, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  git = makeTestGitCli(hooksDir, await hermeticGitEnv(base));
  ({ url: remoteUrl } = await createBareRemote(git, join(base, 'remote.git')));
});

afterEach(async () => {
  for (const machine of machines.splice(0)) {
    await machine.service.close();
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
    const ref = await a.secrets.set('hunter2', { label: 'Password' });
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
    const ref = await a.secrets.set('hunter2', { label: 'Password' });
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
    await b.secrets.replace(ref, 'from-b');
    // B's write commits and pushes at once; A's newer remote rejects that push, so B merges the two
    // vault edits there (or in the pull below, whichever comes first) before pushing again.
    await vi.waitFor(
      async () =>
        expect(((await b.service.sync()?.log(3)) ?? []).map((commit) => commit.subject)).toContain(
          'Update secret Password',
        ),
      WAIT,
    );
    await b.service.sync()?.idle();

    await b.service.sync()?.pull();

    expect(b.conflicts.flat().map((conflict) => conflict.path)).not.toContain(vaultEntryPath(vaultEntryId({ ref })));
    expect(b.service.sync()?.status().state).not.toBe('conflict');
    expect(await b.store.get(ref)).toBe('from-b');
    await b.service.sync()?.push();
    await a.service.sync()?.pull();
    await vi.waitFor(async () => expect(await a.store.get(ref)).toBe('from-b'), WAIT);
  });
});
