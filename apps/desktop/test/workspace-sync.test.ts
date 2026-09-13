// @vitest-environment node
/**
 * `WorkspaceService` + `SyncService` + a real `GitBackend` over a temp bare remote: two app-data
 * roots (two "machines"), each opening its own clone of one shared workspace as its own
 * `WorkspaceService`. Real `fs.watch` and real git; skipped loudly without git (see git-fixture).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createInterface,
  createProject,
  createRequest,
  createWorkspace,
  createWorkspaceEnvironment,
  DEFAULT_GIT_SHARE_SETTINGS,
  saveProject,
  saveShare,
  saveWorkspace,
  workspaceDir,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { GitShareSettings, Project, Workspace } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { GitBackend } from '../src/main/sync/git-backend.js';
import type { GitCli } from '../src/main/sync/git-cli.js';
import type { SyncConflictWire, SyncPulledEvent, SyncStatusWire } from '../src/main/sync/types.js';
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

const WATCH_DEBOUNCE_MS = 30;
const WAIT = { timeout: 15_000, interval: 50 };
const REQUEST_ID = 'req-1';
const PROJECT_ID = 'proj-calc';
/** Long enough for a late watcher event (FSEvents latency + debounce) to have arrived if it was going to. */
const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Machine {
  readonly root: string;
  readonly tree: string;
  readonly service: WorkspaceService;
  readonly projectOnDisk: { projectId: string; paths: readonly string[] }[];
  readonly pulled: SyncPulledEvent[];
  readonly conflicts: SyncConflictWire[][];
  readonly statuses: SyncStatusWire[];
}

let base: string;
let git: GitCli;
let remoteUrl: string;
let workspace: Workspace;
const machines: Machine[] = [];

function calcProject(envelope: string): Project {
  const iface = createInterface('Calc', {
    id: 'iface-1',
    slug: 'Calc',
    definitionUrl: 'http://example.test/calc.wsdl',
    endpoints: [],
    operations: [
      {
        name: 'Add',
        bindingName: '{http://tempuri.org/}CalcSoap',
        slug: 'Add',
        order: 0,
        requests: [
          createRequest('Add one', { id: REQUEST_ID, slug: 'AddOne', envelopeXml: envelope, soapVersion: '1.1' }),
        ],
      },
    ],
  });
  return { ...createProject('Calc', { id: PROJECT_ID }), interfaces: [iface] };
}

function share(overrides: Partial<GitShareSettings> = {}): Parameters<typeof saveShare>[1] {
  return {
    version: 1,
    kind: 'git',
    git: { ...DEFAULT_GIT_SHARE_SETTINGS, remote: remoteUrl, autoFetchSeconds: 0, ...overrides },
  };
}

/** Seeds machine A's tree, commits it and pushes it to the bare remote. */
async function seedShared(): Promise<string> {
  const root = join(base, 'a');
  const created = createWorkspace('Team');
  const dir = workspaceDir(root, created.id);
  const tree = join(dir, 'tree');
  await mkdir(tree, { recursive: true });
  await GitBackend.init(git, tree, 'main');
  await setTestIdentity(git, tree);
  await saveProject(calcProject('<Add>1</Add>'), workspaceProjectDir(tree, 'calc'));
  const dev = { ...createWorkspaceEnvironment('dev', new Set()), properties: { host: 'one' } };
  const staging = { ...createWorkspaceEnvironment('staging', new Set([dev.slug])), properties: { host: 'stage' } };
  workspace = {
    ...created,
    projects: [{ id: PROJECT_ID, slug: 'calc', source: 'internal' }],
    environments: [dev, staging],
  };
  await saveWorkspace(workspace, tree);
  await saveShare(dir, share());
  await git.run(tree, ['remote', 'add', 'origin', remoteUrl]);
  await git.run(tree, ['add', '-A', '--', '.']);
  await git.run(tree, ['commit', '-m', 'Share workspace']);
  await git.run(tree, ['push', 'origin', 'HEAD:refs/heads/main']);
  return root;
}

async function cloneTo(name: string, settings: Partial<GitShareSettings> = {}): Promise<string> {
  const root = join(base, name);
  const dir = workspaceDir(root, workspace.id);
  await mkdir(dir, { recursive: true });
  await GitBackend.clone(git, remoteUrl, 'main', join(dir, 'tree'));
  await setTestIdentity(git, join(dir, 'tree'));
  await saveShare(dir, share(settings));
  return root;
}

async function openMachine(root: string): Promise<Machine> {
  const machine: Machine = {
    root,
    tree: join(workspaceDir(root, workspace.id), 'tree'),
    service: undefined as unknown as WorkspaceService,
    projectOnDisk: [],
    pulled: [],
    conflicts: [],
    statuses: [],
  };
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    watchDebounceMs: WATCH_DEBOUNCE_MS,
    git: () => Promise.resolve(git),
    hooks: {
      onProjectChangedOnDisk: (projectId, paths) => machine.projectOnDisk.push({ projectId, paths: [...paths] }),
      onSyncPulled: (event) => machine.pulled.push(event),
      onSyncConflict: (_workspaceId, conflicts) => machine.conflicts.push([...conflicts]),
      onSyncStatus: (_workspaceId, status) => machine.statuses.push(status),
    },
  });
  (machine as { service: WorkspaceService }).service = service;
  machines.push(machine);
  await service.open(workspace.id);
  // `startSync` runs after `open()` returns; once the service exists its `start()` is already
  // queued, so any op queued now runs after it.
  await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);
  await service.sync()?.log(1);
  await settle(250);
  return machine;
}

async function editRequest(machine: Machine, envelope: string, options: { save: boolean }): Promise<void> {
  const host = machine.service.hostFor(PROJECT_ID);
  await host.mutate({ kind: 'update-request', requestId: REQUEST_ID, patch: { envelopeXml: envelope } });
  if (options.save) {
    await host.save({ reason: 'manual' });
  }
}

/** Waits until the save-triggered commit (and push, when on) has landed. */
async function waitForSubject(machine: Machine, pattern: RegExp): Promise<void> {
  await vi.waitFor(async () => {
    const [latest] = (await machine.service.sync()?.log(1)) ?? [];
    expect(latest?.subject).toMatch(pattern);
  }, WAIT);
}

async function editEnvironment(machine: Machine, slug: string, host: string): Promise<void> {
  const environment = machine.service.snapshot()?.environments.find((candidate) => candidate.slug === slug);
  await machine.service.mutate({
    kind: 'update-workspace-environment',
    environmentId: environment?.id ?? '',
    patch: { properties: { host } },
  });
}

function environmentHost(machine: Machine, slug: string): string | undefined {
  return machine.service.snapshot()?.environments.find((candidate) => candidate.slug === slug)?.properties['host'];
}

beforeEach(async () => {
  base = await mkTempDir('wirebench-workspace-sync-');
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

describeGit('WorkspaceService — git sync', { timeout: 60_000 }, () => {
  it('commits a saved request with a generated subject and pushes it', async () => {
    const a = await openMachine(await seedShared());

    await editRequest(a, '<Add>2</Add>', { save: true });

    await waitForSubject(a, /^Update request AddOne in calc$/);
    await vi.waitFor(() => expect(a.service.sync()?.status()).toMatchObject({ state: 'clean', ahead: 0 }), WAIT);
  });

  it('a second machine sees behind: 1 after fetch, and pull reloads its clean host without a banner', async () => {
    const aRoot = await seedShared();
    const b = await openMachine(await cloneTo('b'));
    const a = await openMachine(aRoot);

    await editRequest(a, '<Add>2</Add>', { save: true });
    await waitForSubject(a, /^Update request AddOne in calc$/);
    await vi.waitFor(() => expect(a.service.sync()?.status().ahead).toBe(0), WAIT);

    const fetched = await b.service.sync()?.fetch();
    expect(fetched).toMatchObject({ behind: 1, ahead: 0 });

    const pulled = await b.service.sync()?.pull();
    expect(pulled).toMatchObject({ state: 'clean', behind: 0 });
    expect(b.service.hostFor(PROJECT_ID).requestSource(REQUEST_ID)?.envelopeXml).toBe('<Add>2</Add>');
    expect(b.pulled).toEqual([
      { workspaceId: workspace.id, projectIds: [PROJECT_ID], workspaceChanged: false, entityCount: 1 },
    ]);
    await settle();
    expect(b.projectOnDisk).toEqual([]);
  });

  it('a dirty host gets onProjectChangedOnDisk instead of a reload', async () => {
    const aRoot = await seedShared();
    const b = await openMachine(await cloneTo('b'));
    const a = await openMachine(aRoot);

    await editRequest(b, '<Add>local</Add>', { save: false });
    await editRequest(a, '<Add>2</Add>', { save: true });
    await waitForSubject(a, /^Update request AddOne in calc$/);
    await vi.waitFor(() => expect(a.service.sync()?.status().ahead).toBe(0), WAIT);

    await b.service.sync()?.pull();

    const host = b.service.hostFor(PROJECT_ID);
    expect(host.snapshot()?.dirty).toBe(true);
    expect(host.requestSource(REQUEST_ID)?.envelopeXml).toBe('<Add>local</Add>');
    expect(b.projectOnDisk).toEqual([
      { projectId: PROJECT_ID, paths: expect.arrayContaining([expect.stringContaining('AddOne')]) as unknown },
    ]);
  });

  it('holds an outside edit while in conflict and applies it after abortMerge', async () => {
    const aRoot = await seedShared();
    const b = await openMachine(await cloneTo('b', { pushOnSave: false }));
    const a = await openMachine(aRoot);

    await editEnvironment(b, 'staging', 'stage-b');
    await waitForSubject(b, /^Update environment staging$/);
    await editEnvironment(a, 'staging', 'stage-a');
    await waitForSubject(a, /^Update environment staging$/);
    await vi.waitFor(() => expect(a.service.sync()?.status().ahead).toBe(0), WAIT);

    const result = await b.service.sync()?.pull();
    expect(result?.state).toBe('conflict');
    expect(b.conflicts.at(-1)?.map((conflict) => conflict.path)).toEqual(['environments/staging.yaml']);
    await settle();

    const devFile = join(b.tree, 'environments', 'dev.yaml');
    const text = await readFile(devFile, 'utf8');
    expect(text).toContain('host: one');
    await writeFile(devFile, text.replace('host: one', 'host: two'), 'utf8');
    await settle();
    expect(environmentHost(b, 'dev')).toBe('one');

    const aborted = await b.service.sync()?.abortMerge();
    expect(aborted?.state).not.toBe('conflict');
    await vi.waitFor(() => expect(environmentHost(b, 'dev')).toBe('two'), WAIT);
    expect(environmentHost(b, 'staging')).toBe('stage-b');
  });

  it('fills a conflict’s projectId from its projects/<slug>/ path', async () => {
    const aRoot = await seedShared();
    const b = await openMachine(await cloneTo('b', { pushOnSave: false }));
    const a = await openMachine(aRoot);

    await editRequest(b, '<Add>b</Add>', { save: true });
    await waitForSubject(b, /^Update request AddOne in calc$/);
    await editRequest(a, '<Add>a</Add>', { save: true });
    await waitForSubject(a, /^Update request AddOne in calc$/);
    await vi.waitFor(() => expect(a.service.sync()?.status().ahead).toBe(0), WAIT);

    await b.service.sync()?.pull();

    const conflicts = b.conflicts.at(-1) ?? [];
    expect(conflicts.length).toBeGreaterThan(0);
    for (const conflict of conflicts) {
      expect(conflict).toMatchObject({ projectId: PROJECT_ID });
    }
    await b.service.sync()?.abortMerge();
  });
});
