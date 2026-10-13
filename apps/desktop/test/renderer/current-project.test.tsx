import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import {
  selectActiveEnvironmentId,
  useActiveEnvironment,
  useWorkspaceStore,
} from '../../src/renderer/state/workspace.js';
import {
  currentProjectId,
  rememberFocusedProject,
  useCurrentProjectId,
} from '../../src/renderer/state/workspace-tabs.js';
import type { WorkspaceEnvironmentWire, WorkspaceProjectWire } from '../../src/shared/wire-base.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

function ref(id: string): WorkspaceProjectWire {
  return { id, name: id, slug: id, source: 'internal', dir: `/tmp/${id}`, status: 'ready' };
}

function environment(id: string, projects?: string[]): WorkspaceEnvironmentWire {
  return {
    id,
    name: id,
    slug: id,
    order: 0,
    properties: {},
    endpoints: {},
    disabled: [],
    ...(projects !== undefined ? { projects } : {}),
  };
}

const WORKSPACE = workspaceWire({
  projects: [ref('p1'), ref('p2')],
  environments: [environment('e-all'), environment('e-p2', ['p2'])],
  activeEnvironments: { p1: 'e-all', p2: 'e-p2' },
});

function openTab(kind: 'rest-request' | 'cookies', entityId?: string): void {
  useEditorsStore.getState().open({
    id: `${kind}:${entityId ?? 'x'}`,
    kind,
    title: kind,
    ...(entityId !== undefined ? { restRequestId: entityId } : {}),
  });
}

describe('current project (#468)', () => {
  let stop: () => void = () => undefined;

  beforeEach(() => {
    installWirebenchApi({});
    useEditorsStore.getState().reset();
    useWorkspaceStore.setState({ workspace: WORKSPACE, lastProjectId: undefined });
    useProjectStore.setState({ projectOf: { r1: 'p1', r2: 'p2' } });
    stop = rememberFocusedProject();
  });

  afterEach(() => {
    stop();
    cleanup();
  });

  it('is the focused tab’s project', () => {
    const { result } = renderHook(() => useCurrentProjectId());
    expect(result.current).toBeUndefined();
    act(() => openTab('rest-request', 'r1'));
    expect(result.current).toBe('p1');
    act(() => openTab('rest-request', 'r2'));
    expect(result.current).toBe('p2');
    expect(currentProjectId()).toBe('p2');
  });

  it('falls back to the last focused project when the focused tab has none', () => {
    const { result } = renderHook(() => useCurrentProjectId());
    act(() => openTab('rest-request', 'r2'));
    act(() => openTab('cookies'));
    expect(result.current).toBe('p2');
    expect(currentProjectId()).toBe('p2');
    act(() => useEditorsStore.getState().showStart());
    expect(result.current).toBe('p2');
  });

  it('forgets a last project that left the workspace, and resets with the workspace', () => {
    const { result } = renderHook(() => useCurrentProjectId());
    act(() => openTab('rest-request', 'r2'));
    act(() => openTab('cookies'));
    act(() => useWorkspaceStore.setState({ workspace: { ...WORKSPACE, projects: [ref('p1')] } }));
    expect(result.current).toBeUndefined();
    act(() => useWorkspaceStore.setState({ workspace: WORKSPACE }));
    expect(result.current).toBe('p2');
    act(() => useWorkspaceStore.getState().applySnapshot(null));
    expect(useWorkspaceStore.getState().lastProjectId).toBeUndefined();
  });

  it('answers each project’s own active environment', () => {
    const { result: p1 } = renderHook(() => useActiveEnvironment('p1'));
    const { result: p2 } = renderHook(() => useActiveEnvironment('p2'));
    const { result: none } = renderHook(() => useActiveEnvironment(undefined));
    expect(p1.current?.id).toBe('e-all');
    expect(p2.current?.id).toBe('e-p2');
    expect(none.current).toBeUndefined();
    expect(selectActiveEnvironmentId(useWorkspaceStore.getState(), 'p1')).toBe('e-all');
    expect(selectActiveEnvironmentId(useWorkspaceStore.getState(), 'p3')).toBeUndefined();

    // An entry whose environment no longer applies to its project is no active environment.
    act(() =>
      useWorkspaceStore.setState({ workspace: { ...WORKSPACE, activeEnvironments: { p1: 'e-p2', p2: 'e-p2' } } }),
    );
    expect(p1.current).toBeUndefined();
    expect(p2.current?.id).toBe('e-p2');
  });

  it('setActiveEnvironment names the project', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue({
      ok: true,
      value: { workspace: { ...WORKSPACE, activeEnvironments: { p1: 'e-all' } } },
    });
    installWirebenchApi({ workspace: { setActiveEnvironment } });
    await useWorkspaceStore.getState().setActiveEnvironment('p2', null);
    expect(setActiveEnvironment).toHaveBeenCalledWith({ projectId: 'p2', environmentId: null });
    expect(useWorkspaceStore.getState().workspace?.activeEnvironments).toEqual({ p1: 'e-all' });
  });
});
