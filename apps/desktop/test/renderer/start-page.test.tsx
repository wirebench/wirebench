import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StartPage, projectIsEmpty } from '../../src/renderer/features/explorer/start-page.js';
import { explorerActions } from '../../src/renderer/features/explorer/explorer-actions.js';
import { workspaceActions } from '../../src/renderer/features/workspace/workspace-actions.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceProjectWire } from '../../src/shared/wire-base.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restApiWire } from '../helpers/wire-defaults.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

function wireProject(patch: Partial<WorkspaceProjectWire> = {}): WorkspaceProjectWire {
  return {
    id: 'p1',
    name: 'Pets',
    slug: 'Pets',
    source: 'internal',
    dir: '/tmp/workspaces/w1/projects/Pets',
    status: 'ready',
    ...patch,
  };
}

function openWorkspace(projects: readonly WorkspaceProjectWire[]): void {
  useWorkspaceStore.setState({ workspace: workspaceWire({ projects }) });
}

/** Gives project `p1` one REST API. */
function withApi(): void {
  useProjectStore.setState({
    rest: { p1: { apis: [restApiWire({ id: 'api-1' })], folders: [], requests: [] } },
  });
}

describe('StartPage', () => {
  beforeEach(() => {
    installWirebenchApi();
    useProjectStore.setState({ projects: {}, interfaces: {}, requests: {}, order: [], rest: {}, projectOf: {} });
    useUiStore.setState({ selection: undefined });
    openWorkspace([wireProject()]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers the three ways into the only project while it has nothing in it', () => {
    const newApi = vi.spyOn(explorerActions, 'newApi').mockImplementation(() => undefined);
    const importCurl = vi.spyOn(explorerActions, 'importCurlIntoNewApi').mockImplementation(() => undefined);
    render(<StartPage />);

    const card = screen.getByTestId('start-empty-project');
    expect(card.textContent).toContain('Pets has no APIs yet.');
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['New REST API…', 'Import definition…', 'Import cURL…']);

    fireEvent.click(screen.getByRole('button', { name: 'New REST API…' }));
    expect(newApi).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: 'Import cURL…' }));
    expect(importCurl).toHaveBeenCalledWith('p1');
  });

  it('opens the Import dialog on the empty project, selected', () => {
    render(<StartPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Import definition…' }));
    expect(useUiStore.getState().selection).toEqual({ kind: 'project', id: 'p1' });
    expect(useUiStore.getState().importDialogOpen).toBe(true);
  });

  it('speaks for the selected project when the workspace holds several', () => {
    openWorkspace([wireProject(), wireProject({ id: 'p2', name: 'Shop', slug: 'Shop' })]);
    withApi();
    useUiStore.setState({ selection: { kind: 'project', id: 'p2' } });
    render(<StartPage />);
    expect(screen.getByTestId('start-empty-project').textContent).toContain('Shop has no APIs yet.');
  });

  it('offers a new request, Import… and Switch workspace… once there is an API', () => {
    withApi();
    const newRequest = vi.spyOn(explorerActions, 'newRestRequest').mockImplementation(() => undefined);
    render(<StartPage />);

    expect(screen.queryByTestId('start-empty-project')).toBeNull();
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['New request', 'Import…', 'Switch workspace…']);
    fireEvent.click(screen.getByRole('button', { name: 'New request' }));
    expect(newRequest).toHaveBeenCalledWith('api-1', undefined);
  });

  it('leaves out New request when there is no REST API to put it in', () => {
    openWorkspace([wireProject(), wireProject({ id: 'p2', name: 'Shop', slug: 'Shop' })]);
    render(<StartPage />);
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Import…', 'Switch workspace…']);
  });

  it('opens the workspace switcher from Switch workspace…', () => {
    vi.useFakeTimers();
    try {
      withApi();
      render(<StartPage />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch workspace…' }));
      vi.runAllTimers();
      expect(useUiStore.getState().workspaceSwitcherOpen).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers New project first, then Import…, in a workspace with no project, as the Explorer does (#686 E20)', () => {
    const newProject = vi.spyOn(workspaceActions, 'newProject').mockImplementation(() => undefined);
    openWorkspace([]);
    render(<StartPage />);
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['New project', 'Import…', 'Switch workspace…']);
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(newProject).toHaveBeenCalled();
    newProject.mockRestore();
  });
});

describe('projectIsEmpty', () => {
  it('is true with no containers and false once the project holds an API', () => {
    useProjectStore.setState({ projects: {}, interfaces: {}, requests: {}, order: [], rest: {} });
    expect(projectIsEmpty(useProjectStore.getState(), 'p1')).toBe(true);
    withApi();
    expect(projectIsEmpty(useProjectStore.getState(), 'p1')).toBe(false);
  });
});
