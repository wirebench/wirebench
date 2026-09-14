// @vitest-environment node
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { registerProjectChannels } from '../src/main/ipc/project.js';
import type { ProjectChannelDeps } from '../src/main/ipc/project.js';
import type { ProjectWire } from '../src/shared/wire-types.js';
import { NO_REST, PROJECT_SETTINGS } from './helpers/wire-defaults.js';

/** A valid reply body, so an accepted import's envelope passes the response schema. */
const PROJECT: ProjectWire = {
  ...NO_REST,
  settings: PROJECT_SETTINGS,
  id: 'p1',
  name: 'Calculator',
  dir: '/user-data/workspaces/w1/projects/Calculator',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  disabledProperties: [],
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

describe('project.addInterface', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('forwards auth and useForRequests to the project service', async () => {
    // `useForRequests` is what persists `Interface.auth`; dropping it here silently produced an
    // interface whose requests then went out unauthenticated.
    const addInterface = vi.fn().mockResolvedValue({ project: null, interfaceId: 'iface-1' });
    registerProjectChannels({
      router: { addInterface } as unknown as ProjectChannelDeps['router'],
      addProject: vi.fn(),
      removeProject: vi.fn(),
      projectDirs: () => [],
      picks: new DialogPicks(),
    });

    await invoke('project.addInterface', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1' },
      useForRequests: true,
    });

    expect(addInterface).toHaveBeenCalledWith('p1', {
      source: { kind: 'url', url: 'http://example.test/x?wsdl' },
      auth: { username: 'alice', passwordRef: 'sec_1' },
      useForRequests: true,
    });
  });
});

describe('project.addInterface with a newProjectName whose import fails', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('removes the project it created (to the trash) and reports the import error', async () => {
    const failure = Object.assign(new Error('WSDL not found'), { code: 'fetch-failed' });
    const addInterface = vi.fn().mockRejectedValue(failure);
    const addProject = vi.fn().mockResolvedValue({ projectId: 'p-new' });
    const removeProject = vi.fn().mockResolvedValue(undefined);
    registerProjectChannels({
      router: { addInterface } as unknown as ProjectChannelDeps['router'],
      addProject,
      removeProject,
      projectDirs: () => [],
      picks: new DialogPicks(),
    });

    const result = await invoke('project.addInterface', {
      target: { newProjectName: 'Calculator' },
      source: { kind: 'url', url: 'http://example.test/missing?wsdl' },
    });

    expect(result).toMatchObject({ ok: false, error: { message: 'WSDL not found' } });
    expect(removeProject).toHaveBeenCalledWith('p-new', { deleteFiles: true });
  });

  it('still reports the import error when the rollback fails too', async () => {
    registerProjectChannels({
      router: {
        addInterface: vi.fn().mockRejectedValue(new Error('WSDL not found')),
      } as unknown as ProjectChannelDeps['router'],
      addProject: vi.fn().mockResolvedValue({ projectId: 'p-new' }),
      removeProject: vi.fn().mockRejectedValue(new Error('trash unavailable')),
      projectDirs: () => [],
      picks: new DialogPicks(),
    });

    const result = await invoke('project.addInterface', {
      target: { newProjectName: 'Calculator' },
      source: { kind: 'url', url: 'http://example.test/missing?wsdl' },
    });

    expect(result).toMatchObject({ ok: false, error: { message: 'WSDL not found' } });
  });

  it('leaves an existing target project alone when its import fails', async () => {
    const removeProject = vi.fn();
    registerProjectChannels({
      router: {
        addInterface: vi.fn().mockRejectedValue(new Error('WSDL not found')),
      } as unknown as ProjectChannelDeps['router'],
      addProject: vi.fn(),
      removeProject,
      projectDirs: () => [],
      picks: new DialogPicks(),
    });

    await invoke('project.addInterface', {
      target: { projectId: 'p1' },
      source: { kind: 'url', url: 'http://example.test/missing?wsdl' },
    });

    expect(removeProject).not.toHaveBeenCalled();
  });
});

/**
 * A `file` source is a read at a renderer-named path, so it answers the same question as
 * `definition.import { kind: 'file' }`: picked in an Open dialog this session, or inside an open
 * project folder. Anything else is refused before a project is created or a byte is read.
 */
describe('project.addInterface file-path access', () => {
  let projectRoot: string;
  let outside: string;
  let picks: DialogPicks;
  let addInterface: ReturnType<typeof vi.fn<ProjectChannelDeps['router']['addInterface']>>;
  let addProject: ReturnType<typeof vi.fn<ProjectChannelDeps['addProject']>>;

  beforeEach(async () => {
    handlers.clear();
    projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'wirebench-add-iface-project-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'wirebench-add-iface-outside-')));
    picks = new DialogPicks();
    addInterface = vi
      .fn<ProjectChannelDeps['router']['addInterface']>()
      .mockResolvedValue({ project: PROJECT, interfaceId: 'iface-1' });
    addProject = vi.fn<ProjectChannelDeps['addProject']>().mockResolvedValue({ projectId: 'p-new' });
    registerProjectChannels({
      router: { addInterface } as unknown as ProjectChannelDeps['router'],
      addProject,
      removeProject: vi.fn(),
      projectDirs: () => [projectRoot],
      picks,
    });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('accepts a path the user picked in the Open dialog', async () => {
    const path = join(outside, 'picked.wsdl');
    picks.rememberRead(path);

    const result = await invoke('project.addInterface', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path },
    });

    expect(result).toMatchObject({ ok: true });
    expect(addInterface).toHaveBeenCalledWith('p1', { source: { kind: 'file', path } });
  });

  it('accepts a path inside an open project folder', async () => {
    const path = join(projectRoot, 'definitions', 'calc.wsdl');

    const result = await invoke('project.addInterface', {
      target: { newProjectName: 'Calculator' },
      source: { kind: 'file', path },
    });

    expect(result).toMatchObject({ ok: true });
    expect(addInterface).toHaveBeenCalledWith('p-new', { source: { kind: 'file', path } });
  });

  it('refuses an arbitrary absolute path with the error definition.import uses', async () => {
    const path = join(outside, 'secrets.txt');

    for (const target of [{ projectId: 'p1' }, { newProjectName: 'Calculator' }]) {
      const result = await invoke('project.addInterface', { target, source: { kind: 'file', path } });
      expect(result).toMatchObject({ ok: false, error: { code: 'import-path-refused' } });
    }
    expect(addInterface).not.toHaveBeenCalled();
    // Refused before a project is created, so a refusal leaves the workspace as it was.
    expect(addProject).not.toHaveBeenCalled();
  });

  it('refuses a relative path that escapes the project folder', async () => {
    const path = join(projectRoot, '..', 'elsewhere.wsdl');
    const result = await invoke('project.addInterface', {
      target: { projectId: 'p1' },
      source: { kind: 'file', path },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'import-path-refused' } });
    expect(addInterface).not.toHaveBeenCalled();
  });
});
