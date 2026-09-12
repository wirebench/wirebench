import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { EnvironmentPage } from '../../src/renderer/features/environments/environment-page.js';
import { useGlobalsStore } from '../../src/renderer/state/globals.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { EnvironmentWire, ProjectWire, WorkspaceEnvironmentWire } from '../../src/shared/wire-types.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

function renderPage(target: Parameters<typeof EnvironmentPage>[0]['target']) {
  return render(
    <TooltipPrimitive.Provider>
      <EnvironmentPage target={target} />
    </TooltipPrimitive.Provider>,
  );
}

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ workspace: null });
  useProjectStore.getState().reset();
  useGlobalsStore.setState({ properties: {}, disabled: [] });
});

describe('EnvironmentPage — globals', () => {
  it('shows the fixed Globals name and its properties', () => {
    useGlobalsStore.setState({ properties: { token: 'abc' }, disabled: [] });
    renderPage({ kind: 'globals' });
    expect(screen.getByRole('heading', { name: 'Globals' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('abc');
  });

  it('has no editable name and no Active toggle', () => {
    renderPage({ kind: 'globals' });
    expect(screen.queryByLabelText('Environment name')).toBeNull();
    expect(screen.queryByTestId('environment-active')).toBeNull();
  });

  it('saves an edit through globals.set', () => {
    const set = vi.fn().mockResolvedValue(undefined);
    useGlobalsStore.setState({ properties: { token: 'abc' }, disabled: [], set });
    renderPage({ kind: 'globals' });
    const value = screen.getByLabelText('Value of token');
    fireEvent.change(value, { target: { value: 'xyz' } });
    fireEvent.blur(value);
    expect(set).toHaveBeenCalledWith('token', 'xyz');
  });
});

describe('EnvironmentPage — workspace', () => {
  it('shows the fixed Workspace name and its properties', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ properties: { host: 'one.test' } }) });
    renderPage({ kind: 'workspace' });
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Value of host').value).toBe('one.test');
  });

  it('inherits from Globals, shown in a read-only Inherited group', () => {
    useGlobalsStore.setState({ properties: { token: 'abc' }, disabled: [] });
    useWorkspaceStore.setState({ workspace: workspaceWire({ properties: { host: 'one.test' } }) });
    renderPage({ kind: 'workspace' });
    expect(screen.getAllByTestId('env-variable-group').map((group) => group.textContent)).toEqual([
      'Set here · Workspace',
      'Inherited · read-only',
    ]);
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('abc');
    expect(screen.getByLabelText<HTMLInputElement>('Enable token').disabled).toBe(true);
  });

  it('saves an edit through a set-workspace-property mutation', () => {
    const mutate = vi.fn().mockResolvedValue({});
    useWorkspaceStore.setState({
      workspace: workspaceWire({ properties: { host: 'one.test' } }),
      mutate,
    });
    renderPage({ kind: 'workspace' });
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.blur(value);
    expect(mutate).toHaveBeenCalledWith({ kind: 'set-workspace-property', name: 'host', value: 'two.test' });
  });
});

describe('EnvironmentPage — a workspace environment', () => {
  const environment: WorkspaceEnvironmentWire = {
    id: 'e1',
    name: 'uat',
    slug: 'uat',
    order: 0,
    endpoints: {},
    properties: { host: 'one.test' },
    disabled: [],
  };

  function setUp(env: WorkspaceEnvironmentWire = environment, activeEnvironmentId?: string) {
    const mutate = vi.fn((change: { kind: string; environmentId?: string; patch?: object }) => {
      if (change.kind === 'update-workspace-environment') {
        const current = useWorkspaceStore.getState().workspace;
        if (current !== null) {
          const environments = current.environments.map((candidate) =>
            candidate.id === change.environmentId ? { ...candidate, ...change.patch } : candidate,
          );
          useWorkspaceStore.setState({ workspace: { ...current, environments } });
        }
      }
      return Promise.resolve({});
    });
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [env],
        ...(activeEnvironmentId !== undefined ? { activeEnvironmentId } : {}),
      }),
      mutate: mutate as unknown as ReturnType<typeof useWorkspaceStore.getState>['mutate'],
      setActiveEnvironment,
    });
    renderPage({ kind: 'environment', id: env.id });
    return { mutate, setActiveEnvironment };
  }

  it('shows an editable name and the Active toggle', () => {
    setUp();
    expect(screen.getByLabelText<HTMLInputElement>('Environment name').value).toBe('uat');
    expect(screen.getByTestId('environment-active')).toBeTruthy();
  });

  it('renames on blur', async () => {
    const { mutate } = setUp();
    const name = screen.getByLabelText('Environment name');
    fireEvent.change(name, { target: { value: 'staging' } });
    fireEvent.blur(name);
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e1',
        patch: { name: 'staging' },
      });
    });
  });

  it('activates through the workspace store when toggled on', () => {
    const { setActiveEnvironment } = setUp(environment, undefined);
    fireEvent.click(screen.getByTestId('environment-active'));
    expect(setActiveEnvironment).toHaveBeenCalledWith('e1');
  });

  it('deactivates through the workspace store when toggled off', () => {
    const { setActiveEnvironment } = setUp(environment, 'e1');
    fireEvent.click(screen.getByTestId('environment-active'));
    expect(setActiveEnvironment).toHaveBeenCalledWith(null);
  });

  it('toggles a variable disabled and back through the disabled list', async () => {
    const { mutate } = setUp();
    fireEvent.click(screen.getByLabelText('Enable host'));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenLastCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e1',
        patch: { disabled: ['host'] },
      });
    });
  });

  it('puts the variables table above the endpoints group, per spec §2.2', () => {
    setUp();
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Variables',
      'Endpoints',
    ]);
  });

  it('carries the disabled flag across a rename, so a disabled variable does not re-enable itself', async () => {
    const { mutate } = setUp({ ...environment, disabled: ['host'] });
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenLastCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e1',
        patch: { properties: { hostname: 'one.test' }, disabled: ['hostname'] },
      });
    });
  });

  it('falls back through Workspace then Globals, nearest first', () => {
    useGlobalsStore.setState({ properties: { token: 'global-token', shared: 'from-globals' }, disabled: [] });
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [environment],
        properties: { shared: 'from-workspace' },
      }),
    });
    renderPage({ kind: 'environment', id: environment.id });
    expect(screen.getAllByTestId('env-variable-group').map((group) => group.textContent)).toEqual([
      'Set here · This environment',
      'Inherited · read-only',
    ]);
    // `shared` is defined by both Workspace and Globals — Workspace, being nearer, wins.
    expect(screen.getByLabelText<HTMLInputElement>('Value of shared').value).toBe('from-workspace');
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('global-token');
  });
});

describe("EnvironmentPage — a linked project's own environment", () => {
  const environment: EnvironmentWire = {
    id: 'e1',
    name: 'uat',
    slug: 'uat',
    order: 0,
    endpoints: {},
    properties: { host: 'one.test' },
    disabled: ['host'],
  };

  function setUp() {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      projects: { p1: { id: 'p1', name: 'Demo', environments: [environment] } as unknown as ProjectWire },
      projectOf: { e1: 'p1' },
      updateEnvironment,
    });
    renderPage({ kind: 'environment', id: 'e1' });
    return { updateEnvironment };
  }

  it('shows an editable name too', () => {
    setUp();
    expect(screen.getByLabelText<HTMLInputElement>('Environment name').value).toBe('uat');
  });

  it("shows the disabled state read-only — there is no mutation for a project environment's disabled list", () => {
    setUp();
    const checkbox = screen.getByLabelText<HTMLInputElement>('Enable host');
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
  });

  it('saves a property edit through the project store', () => {
    const { updateEnvironment } = setUp();
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.blur(value);
    expect(updateEnvironment).toHaveBeenCalledWith('p1', 'e1', { properties: { host: 'two.test' } });
  });

  it('falls back through Workspace then Globals too, same as a workspace environment', () => {
    useGlobalsStore.setState({ properties: { shared: 'from-globals' }, disabled: [] });
    useWorkspaceStore.setState({ workspace: workspaceWire({ properties: { shared: 'from-workspace' } }) });
    setUp();
    expect(screen.getAllByTestId('env-variable-group').map((group) => group.textContent)).toEqual([
      'Set here · This environment',
      'Inherited · read-only',
    ]);
    expect(screen.getByLabelText<HTMLInputElement>('Value of shared').value).toBe('from-workspace');
  });

  it('names the owning project in the header, so two projects with a same-named environment stay distinguishable', () => {
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        projects: [{ id: 'p1', name: 'Demo', slug: 'demo', source: 'linked', dir: '/w/demo', status: 'ready' }],
      }),
    });
    setUp();
    expect(screen.getByTestId('environment-owning-project').textContent).toBe('Demo — linked project');
  });

  it('falls back to a generic caption when the owning project cannot be resolved', () => {
    setUp();
    expect(screen.getByTestId('environment-owning-project').textContent).toBe('this project — linked project');
  });
});
