import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { DEFAULT_PROJECT_SETTINGS } from '@wirebench/engine';
import { ProjectTab } from '../../src/renderer/features/project/project-tab.js';
import { useGlobalsStore } from '../../src/renderer/state/globals.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST } from '../helpers/wire-defaults.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';

function project(patch: Partial<ProjectWire> = {}): ProjectWire {
  return {
    ...NO_REST,
    id: 'p1',
    name: 'Demo',
    dir: '/tmp/workspaces/w1/projects/Demo',
    dirty: false,
    interfaces: [],
    requests: [],
    properties: { host: 'example.test' },
    disabledProperties: [],
    environments: [],
    problems: [],
    settings: DEFAULT_PROJECT_SETTINGS,
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
    ...patch,
  };
}

function renderTab(projectId = 'p1'): void {
  render(
    <TooltipPrimitive.Provider>
      <ProjectTab projectId={projectId} />
    </TooltipPrimitive.Provider>,
  );
}

describe('ProjectTab', () => {
  beforeEach(() => {
    installWirebenchApi({});
    useProjectStore.getState().reset();
    useWorkspaceStore.setState({
      workspace: {
        id: 'w1',
        name: 'Workspace',
        dir: '/tmp/w1',
        properties: {},
        disabled: [],
        environments: [],
        projects: [
          {
            id: 'p1',
            name: 'Demo',
            slug: 'Demo',
            source: 'internal',
            dir: '/tmp/workspaces/w1/projects/Demo',
            status: 'ready',
          },
          { id: 'p2', name: 'Billing', slug: 'Billing', source: 'linked', dir: '/elsewhere/billing', status: 'ready' },
        ],
      },
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('says the project is no longer in the workspace when it is gone', () => {
    renderTab();
    expect(screen.getByText('This project is no longer in the workspace.')).toBeTruthy();
  });

  it('shows the name, folder and source', () => {
    useProjectStore.setState({ projects: { p1: project() } });
    renderTab();

    expect(screen.getByLabelText('Name').textContent).toBe('Demo');
    expect(screen.getByLabelText<HTMLInputElement>('Folder').value).toBe('/tmp/workspaces/w1/projects/Demo');
    expect(screen.getByLabelText('Source').textContent).toBe('Internal');
  });

  it('reports a linked project as linked', () => {
    useProjectStore.setState({ projects: { p1: project(), p2: project({ id: 'p2', name: 'Billing' }) } });
    renderTab('p2');
    expect(screen.getByLabelText('Source').textContent).toBe('Linked');
  });

  it('reveals the project folder by id only, never by path', () => {
    const revealProject = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ projects: { p1: project() } });
    useWorkspaceStore.setState({ revealProject } as never);
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(revealProject).toHaveBeenCalledWith('p1');
    expect(revealProject).not.toHaveBeenCalledWith(expect.stringContaining('/tmp'));
  });

  it('patches ProjectSettings through updateProjectSettings', async () => {
    const updateProjectSettings = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ projects: { p1: project() }, updateProjectSettings });
    renderTab();

    fireEvent.click(screen.getByLabelText('Cache definitions'));
    await waitFor(() => {
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { cacheDefinitions: false });
    });

    const timeout = screen.getByLabelText('Default timeout (ms)');
    fireEvent.change(timeout, { target: { value: '5000' } });
    fireEvent.blur(timeout);
    await waitFor(() => {
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { defaultTimeoutMs: 5000 });
    });

    const resourceRoot = screen.getByLabelText('Resource root');
    fireEvent.change(resourceRoot, { target: { value: 'resources' } });
    fireEvent.blur(resourceRoot);
    await waitFor(() => {
      expect(updateProjectSettings).toHaveBeenCalledWith('p1', { resourceRoot: 'resources' });
    });
  });

  it('edits the project properties through the reused variables table', async () => {
    const setProjectProperty = vi.fn().mockResolvedValue(undefined);
    const removeProjectProperty = vi.fn().mockResolvedValue(undefined);
    const setProjectPropertyEnabled = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      projects: { p1: project() },
      setProjectProperty,
      removeProjectProperty,
      setProjectPropertyEnabled,
    });
    renderTab();

    expect(screen.getByTestId('project-properties-table')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Value of host').value).toBe('example.test');

    fireEvent.click(screen.getByLabelText('Enable host'));
    await waitFor(() => {
      expect(setProjectPropertyEnabled).toHaveBeenCalledWith('p1', 'host', false);
    });

    fireEvent.click(screen.getByTestId('env-variable-delete'));
    await waitFor(() => {
      expect(removeProjectProperty).toHaveBeenCalledWith('p1', 'host');
    });

    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: '8080' } });
    fireEvent.keyDown(screen.getByLabelText('New variable value'), { key: 'Enter' });
    await waitFor(() => {
      expect(setProjectProperty).toHaveBeenCalledWith('p1', 'port', '8080');
    });
  });

  it('falls back through Workspace then Globals for the project properties table', () => {
    useGlobalsStore.setState({ properties: { shared: 'from-globals' }, disabled: [] });
    useWorkspaceStore.setState({
      workspace: {
        id: 'w1',
        name: 'Workspace',
        dir: '/tmp/w1',
        properties: { shared: 'from-workspace' },
        disabled: [],
        environments: [],
        projects: [
          {
            id: 'p1',
            name: 'Demo',
            slug: 'Demo',
            source: 'internal',
            dir: '/tmp/workspaces/w1/projects/Demo',
            status: 'ready',
          },
        ],
      },
    } as never);
    useProjectStore.setState({ projects: { p1: project() } });
    renderTab();

    const table = screen.getByTestId('project-properties-table');
    expect(
      Array.from(table.querySelectorAll('[data-testid="env-variable-group"]')).map((group) => group.textContent),
    ).toEqual(['Set here · This project', 'Inherited · read-only']);
    expect(screen.getByLabelText<HTMLInputElement>('Value of shared').value).toBe('from-workspace');
  });
});
