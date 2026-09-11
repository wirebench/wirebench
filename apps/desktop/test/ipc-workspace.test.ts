// @vitest-environment node
/**
 * `workspace.*` and the reshaped `project.*` channels, through the handler-capture pattern:
 * every channel is registered against a fake service, invoked with a raw payload exactly as the
 * preload would send it, and checked for what it forwarded and what envelope came back.
 *
 * The fake is the point: these tests are about the *contract* — which service method a channel
 * reaches, with which arguments, and that nothing path-shaped ever crosses from the renderer —
 * not about `WorkspaceService` itself, which has suites of its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { registerProjectChannels } from '../src/main/ipc/project.js';
import { registerWorkspaceChannels } from '../src/main/ipc/workspace.js';
import { channels } from '../src/shared/ipc.js';
import type { ProjectWire, WorkspaceSummaryWire, WorkspaceWire } from '../src/shared/wire-types.js';
import { PROJECT_SETTINGS } from './helpers/wire-defaults.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

/** Stands in for the invoking window: the dialog-driven channels must hand it to the service. */
const SENDER = { id: 42 };

type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

function invoke(channel: string, payload?: unknown): Promise<Envelope> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: SENDER }, payload) as Promise<Envelope>;
}

const WORKSPACE: WorkspaceWire = {
  id: 'w1',
  name: 'Workspace 1',
  dir: '/user-data/workspaces/w1',
  properties: {},
  environments: [],
  projects: [
    {
      id: 'p1',
      name: 'Calculator',
      slug: 'Calculator',
      source: 'internal',
      dir: '/user-data/workspaces/w1/projects/Calculator',
      status: 'ready',
    },
  ],
};

const SUMMARY: WorkspaceSummaryWire = {
  id: 'w1',
  name: 'Workspace 1',
  dir: '/user-data/workspaces/w1',
  projectCount: 1,
  createdAt: '2026-09-11T00:00:00.000Z',
};

const PROJECT: ProjectWire = {
  settings: PROJECT_SETTINGS,
  id: 'p1',
  name: 'Calculator',
  dir: '/user-data/workspaces/w1/projects/Calculator',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

/** A `WorkspaceService` double: every method resolves to a valid wire value and is spied on. */
function fakeService() {
  return {
    list: vi.fn().mockResolvedValue([SUMMARY]),
    create: vi.fn().mockResolvedValue(WORKSPACE),
    open: vi.fn().mockResolvedValue(WORKSPACE),
    close: vi.fn().mockResolvedValue(null),
    snapshot: vi.fn().mockReturnValue(WORKSPACE),
    rename: vi.fn().mockResolvedValue([{ ...SUMMARY, name: 'Renamed' }]),
    delete: vi.fn().mockResolvedValue([]),
    addProject: vi.fn().mockResolvedValue({ workspace: WORKSPACE, projectId: 'p2' }),
    removeProject: vi.fn().mockResolvedValue(WORKSPACE),
    linkProject: vi.fn().mockResolvedValue(WORKSPACE),
    importProjectFolder: vi.fn().mockResolvedValue(null),
    exportProject: vi.fn().mockResolvedValue({ dir: '/picked/export' }),
    locateProject: vi.fn().mockResolvedValue(WORKSPACE),
    setActiveEnvironment: vi.fn().mockResolvedValue(WORKSPACE),
    mutate: vi.fn().mockResolvedValue({ workspace: WORKSPACE, createdEnvironmentId: 'e1' }),
  };
}

let service: ReturnType<typeof fakeService>;
let suggestions: ReturnType<typeof vi.fn<() => Promise<readonly string[]>>>;

beforeEach(() => {
  handlers.clear();
  service = fakeService();
  suggestions = vi.fn<() => Promise<readonly string[]>>().mockResolvedValue([]);
  registerWorkspaceChannels({ service, suggestions });
});

describe('workspace.* channels', () => {
  it('registers every channel the contract declares', () => {
    const declared = Object.values(channels.workspace).map((channel) => channel.name);
    expect([...handlers.keys()].sort()).toEqual([...declared].sort());
    expect(declared).toHaveLength(15);
  });

  it('none of them accepts a filesystem path from the renderer', () => {
    // A request schema with a `path`/`dir` field would let the renderer name a folder the app
    // then reads or writes; link/import/export/locate run their own dialog in main instead.
    for (const channel of Object.values(channels.workspace)) {
      const shape = (channel.request as { shape?: Record<string, unknown> }).shape ?? {};
      expect(
        Object.keys(shape).filter((key) => /path|dir/i.test(key)),
        channel.name,
      ).toEqual([]);
    }
    // And an extra `path` is stripped rather than forwarded.
    const parsed = channels.workspace.exportProject.request.parse({ projectId: 'p1', path: '/etc' });
    expect(parsed).toEqual({ projectId: 'p1' });
  });

  it('list returns the summaries, and suggestions only when there are some', async () => {
    await expect(invoke('workspace.list')).resolves.toEqual({ ok: true, value: { workspaces: [SUMMARY] } });

    suggestions.mockResolvedValue(['/old/projects/calc']);
    await expect(invoke('workspace.list')).resolves.toEqual({
      ok: true,
      value: { workspaces: [SUMMARY], suggestions: ['/old/projects/calc'] },
    });
  });

  it('create, open, close and snapshot forward and wrap the workspace', async () => {
    await expect(invoke('workspace.create', { name: 'Payments' })).resolves.toEqual({
      ok: true,
      value: { workspace: WORKSPACE },
    });
    expect(service.create).toHaveBeenCalledWith('Payments');

    await expect(invoke('workspace.open', { workspaceId: 'w1' })).resolves.toEqual({
      ok: true,
      value: { workspace: WORKSPACE },
    });
    expect(service.open).toHaveBeenCalledWith('w1');

    await expect(invoke('workspace.close')).resolves.toEqual({ ok: true, value: { workspace: null } });
    expect(service.close).toHaveBeenCalledTimes(1);

    await expect(invoke('workspace.snapshot')).resolves.toEqual({ ok: true, value: { workspace: WORKSPACE } });
  });

  it('rename and delete return the refreshed picker list', async () => {
    await expect(invoke('workspace.rename', { workspaceId: 'w1', name: 'Renamed' })).resolves.toEqual({
      ok: true,
      value: { workspaces: [{ ...SUMMARY, name: 'Renamed' }] },
    });
    expect(service.rename).toHaveBeenCalledWith('w1', 'Renamed');

    await expect(invoke('workspace.delete', { workspaceId: 'w1' })).resolves.toEqual({
      ok: true,
      value: { workspaces: [] },
    });
    expect(service.delete).toHaveBeenCalledWith('w1');
  });

  it('addProject returns the workspace and the new project id', async () => {
    await expect(invoke('workspace.addProject', { name: 'Billing' })).resolves.toEqual({
      ok: true,
      value: { workspace: WORKSPACE, projectId: 'p2' },
    });
    expect(service.addProject).toHaveBeenCalledWith('Billing');
  });

  it('removeProject forwards deleteFiles as an option', async () => {
    await invoke('workspace.removeProject', { projectId: 'p1', deleteFiles: true });
    expect(service.removeProject).toHaveBeenCalledWith('p1', { deleteFiles: true });
  });

  it('link, import, export and locate hand the invoking window to the service, and nothing else', async () => {
    await expect(invoke('workspace.linkProject')).resolves.toEqual({ ok: true, value: { workspace: WORKSPACE } });
    expect(service.linkProject).toHaveBeenCalledWith(SENDER);

    // Cancelled: `null` crosses as a workspace of `null`, not as a failure.
    await expect(invoke('workspace.importProjectFolder')).resolves.toEqual({ ok: true, value: { workspace: null } });
    expect(service.importProjectFolder).toHaveBeenCalledWith(SENDER);

    await expect(invoke('workspace.exportProject', { projectId: 'p1' })).resolves.toEqual({
      ok: true,
      value: { dir: '/picked/export' },
    });
    expect(service.exportProject).toHaveBeenCalledWith('p1', SENDER);

    service.exportProject.mockResolvedValueOnce(null);
    await expect(invoke('workspace.exportProject', { projectId: 'p1' })).resolves.toEqual({
      ok: true,
      value: { dir: null },
    });

    await expect(invoke('workspace.locateProject', { projectId: 'p1' })).resolves.toEqual({
      ok: true,
      value: { workspace: WORKSPACE },
    });
    expect(service.locateProject).toHaveBeenCalledWith('p1', SENDER);
  });

  it('setActiveEnvironment accepts an id or null', async () => {
    await invoke('workspace.setActiveEnvironment', { environmentId: 'e1' });
    await invoke('workspace.setActiveEnvironment', { environmentId: null });
    expect(service.setActiveEnvironment.mock.calls).toEqual([['e1'], [null]]);
  });

  it('mutate forwards the change and passes the created id through', async () => {
    const change = { kind: 'add-workspace-environment', name: 'dev' };
    await expect(invoke('workspace.mutate', { change })).resolves.toEqual({
      ok: true,
      value: { workspace: WORKSPACE, createdEnvironmentId: 'e1' },
    });
    expect(service.mutate).toHaveBeenCalledWith(change);
  });

  it('refuses a malformed change before the service sees it', async () => {
    const result = await invoke('workspace.mutate', { change: { kind: 'rm-rf', path: '/' } });
    expect(result.ok).toBe(false);
    expect(service.mutate).not.toHaveBeenCalled();
  });

  it('reports a service failure as an error envelope', async () => {
    service.open.mockRejectedValueOnce(Object.assign(new Error('no such workspace'), { code: 'workspace-not-found' }));
    const result = await invoke('workspace.open', { workspaceId: 'nope' });
    expect(result.ok).toBe(false);
  });
});

describe('project.* channels', () => {
  function registerProject() {
    const router = {
      projectSnapshot: vi.fn().mockReturnValue(PROJECT),
      projectMutate: vi.fn().mockResolvedValue({ project: PROJECT }),
      save: vi.fn().mockResolvedValue({ saved: true, written: 1, removed: 0 }),
      addInterface: vi.fn().mockResolvedValue({ project: PROJECT, interfaceId: 'i1' }),
      reload: vi.fn().mockResolvedValue(PROJECT),
    };
    const addProject = vi.fn().mockResolvedValue({ projectId: 'p-new' });
    const removeProject = vi.fn().mockResolvedValue(undefined);
    registerProjectChannels({ router, addProject, removeProject, projectDirs: () => [], picks: new DialogPicks() });
    return { router, addProject, removeProject };
  }

  it('create, open, close and recent are gone from the contract', () => {
    const { router } = registerProject();
    expect(Object.keys(channels.project).sort()).toEqual(['addInterface', 'mutate', 'reload', 'save', 'snapshot']);
    expect(handlers.has('project.open')).toBe(false);
    expect(router).toBeDefined();
  });

  it('snapshot, mutate, save and reload route by projectId', async () => {
    const { router } = registerProject();

    await expect(invoke('project.snapshot', { projectId: 'p1' })).resolves.toEqual({
      ok: true,
      value: { project: PROJECT },
    });
    expect(router.projectSnapshot).toHaveBeenCalledWith('p1');

    const change = { kind: 'set-project-property', name: 'host', value: 'x' };
    await invoke('project.mutate', { projectId: 'p1', change });
    expect(router.projectMutate).toHaveBeenCalledWith('p1', change);

    await invoke('project.save', { projectId: 'p1' });
    expect(router.save).toHaveBeenCalledWith('p1', { reason: 'manual' });

    await invoke('project.reload', { projectId: 'p1' });
    expect(router.reload).toHaveBeenCalledWith('p1');
  });

  it('refuses a project request that names no project', async () => {
    const { router } = registerProject();
    const result = await invoke('project.snapshot', undefined);
    expect(result.ok).toBe(false);
    expect(router.projectSnapshot).not.toHaveBeenCalled();
  });

  it('addInterface imports into the named project', async () => {
    const { router, addProject } = registerProject();
    const source = { kind: 'url', url: 'http://example.test/calc?wsdl' };

    await expect(invoke('project.addInterface', { target: { projectId: 'p1' }, source, token: 't' })).resolves.toEqual({
      ok: true,
      value: { projectId: 'p1', project: PROJECT, interfaceId: 'i1' },
    });
    expect(router.addInterface).toHaveBeenCalledWith('p1', { source, token: 't' });
    expect(addProject).not.toHaveBeenCalled();
  });

  it('addInterface with a newProjectName creates the project first, then imports into it', async () => {
    const { router, addProject } = registerProject();
    const source = { kind: 'url', url: 'http://example.test/calc?wsdl' };

    const result = await invoke('project.addInterface', { target: { newProjectName: 'Calculator' }, source });

    expect(addProject).toHaveBeenCalledWith('Calculator');
    expect(router.addInterface).toHaveBeenCalledWith('p-new', { source });
    expect(result).toEqual({ ok: true, value: { projectId: 'p-new', project: PROJECT, interfaceId: 'i1' } });
  });
});
