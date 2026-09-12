import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { EnvironmentsView } from '../../src/renderer/features/environments/environments-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceEnvironmentWire } from '../../src/shared/wire-types.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const dev: WorkspaceEnvironmentWire = {
  id: 'e1',
  name: 'dev',
  slug: 'dev',
  order: 0,
  endpoints: {},
  properties: {},
  disabled: [],
};
const uat: WorkspaceEnvironmentWire = {
  id: 'e2',
  name: 'uat',
  slug: 'uat',
  order: 1,
  endpoints: {},
  properties: {},
  disabled: [],
};

function setUp(
  patch: { readonly environments?: readonly WorkspaceEnvironmentWire[]; readonly activeEnvironmentId?: string } = {},
) {
  const actions = {
    mutate: vi.fn().mockResolvedValue({}),
    setActiveEnvironment: vi.fn().mockResolvedValue(undefined),
  };
  useWorkspaceStore.setState({
    workspace: workspaceWire({
      environments: patch.environments ?? [dev, uat],
      activeEnvironmentId: patch.activeEnvironmentId ?? 'e1',
    }),
    ...actions,
  });
  render(
    <TooltipPrimitive.Provider>
      <EnvironmentsView />
    </TooltipPrimitive.Provider>,
  );
  return actions;
}

describe('EnvironmentsView', () => {
  beforeEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useUiStore.setState({ details: { ...useUiStore.getState().details, visible: false, tab: 'selection' } });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('lists Globals, Workspace, then the environments in order, with the active one marked', () => {
    setUp();
    const rows = screen.getAllByTestId('environment-row');
    expect(rows.map((row) => row.dataset['kind'])).toEqual(['globals', 'workspace', 'environment', 'environment']);
    expect(rows[0]?.textContent).toBe('Globals');
    expect(rows[1]?.textContent).toBe('Workspace');
    expect(rows[2]?.textContent).toBe('dev');
    expect(rows[3]?.textContent).toContain('uat');
    expect(rows[2]?.dataset['active']).toBe('true');
    expect(rows[3]?.dataset['active']).toBe('false');
  });

  it('opens the Globals details tab from the Open menu item', async () => {
    setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[0]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(useUiStore.getState().details).toMatchObject({ tab: 'globals', visible: true });
  });

  it('offers only Open on the Globals and Workspace rows', async () => {
    setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[1]!);
    const menuItems = await screen.findAllByRole('menuitem');
    expect(menuItems.map((item) => item.textContent)).toEqual(['Open']);
  });

  it('offers the full action set on an environment row', async () => {
    setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[3]!);
    const menuItems = await screen.findAllByRole('menuitem');
    expect(menuItems.map((item) => item.textContent)).toEqual(['Open', 'Set active', 'Rename', 'Duplicate', 'Delete']);
  });

  it('deactivates the active environment from its context menu', async () => {
    const { setActiveEnvironment } = setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[2]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));
    await waitFor(() => {
      expect(setActiveEnvironment).toHaveBeenCalledWith(null);
    });
  });

  it('sets an inactive environment active by clicking its check mark', async () => {
    const { setActiveEnvironment } = setUp();
    const uatRow = screen.getAllByTestId('environment-row')[3]!;
    fireEvent.click(uatRow.querySelector('button[aria-label="Set uat active"]')!);
    await waitFor(() => {
      expect(setActiveEnvironment).toHaveBeenCalledWith('e2');
    });
  });

  it('opens an environment editor tab on double-click', () => {
    setUp();
    fireEvent.doubleClick(screen.getAllByTestId('environment-row')[3]!);
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'env:e2', kind: 'environment', title: 'uat', environmentId: 'e2' },
    ]);
  });

  it('renames an environment inline', async () => {
    const { mutate } = setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[3]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByLabelText('Rename uat');
    fireEvent.change(input, { target: { value: 'staging' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e2',
        patch: { name: 'staging' },
      });
    });
  });

  it('deletes only after the confirmation is accepted', async () => {
    const { mutate } = setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[3]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(mutate).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({ kind: 'remove-workspace-environment', environmentId: 'e2' });
    });
  });

  it('creates and opens a new environment from the toolbar', async () => {
    const created: WorkspaceEnvironmentWire = {
      id: 'e3',
      name: 'Environment 1',
      slug: 'environment-1',
      order: 2,
      endpoints: {},
      properties: {},
      disabled: [],
    };
    const mutate = vi.fn().mockImplementation(() => {
      const current = useWorkspaceStore.getState().workspace!;
      useWorkspaceStore.setState({ workspace: { ...current, environments: [...current.environments, created] } });
      return Promise.resolve({ createdEnvironmentId: 'e3' });
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({ environments: [dev, uat], activeEnvironmentId: 'e1' }),
      mutate,
      setActiveEnvironment: vi.fn().mockResolvedValue(undefined),
    });
    render(
      <TooltipPrimitive.Provider>
        <EnvironmentsView />
      </TooltipPrimitive.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add environment' }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({ kind: 'add-workspace-environment', name: 'Environment 1' });
    });
    await waitFor(() => {
      expect(useEditorsStore.getState().tabs).toEqual([
        { id: 'env:e3', kind: 'environment', title: 'Environment 1', environmentId: 'e3' },
      ]);
    });
  });

  it('collapses the sidebar from the toolbar chevron', () => {
    setUp();
    useUiStore.setState({ sidebar: { visible: true, view: 'environments', size: 20 } });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(useUiStore.getState().sidebar.visible).toBe(false);
  });
});
