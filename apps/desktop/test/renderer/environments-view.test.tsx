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

  it('opens the Globals editor tab from the row itself', () => {
    setUp();
    fireEvent.click(screen.getAllByTestId('environment-row')[0]!);
    expect(useEditorsStore.getState().tabs).toContainEqual(
      expect.objectContaining({ id: 'env:globals', kind: 'environment', title: 'Globals', environmentId: 'globals' }),
    );
    expect(useEditorsStore.getState().activeId).toBe('env:globals');
  });

  it('gives the Globals and Workspace rows no menu at all — a click is all they offer', async () => {
    setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[1]!);
    // `findAllByRole` would wait for a menu that is never coming, so assert the absence.
    await Promise.resolve();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('drops Open from an environment row, since a click already opens it', async () => {
    setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[3]!);
    const menuItems = await screen.findAllByRole('menuitem');
    expect(menuItems.map((item) => item.textContent)).toEqual(['Set active', 'Duplicate', 'Rename', 'Delete']);
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

  it('opens an environment editor tab on a single click', () => {
    setUp();
    fireEvent.click(screen.getAllByTestId('environment-row')[3]!);
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'env:e2', kind: 'environment', title: 'uat', environmentId: 'e2' },
    ]);
  });

  it('opens a fixed scope on a single click', () => {
    setUp();
    fireEvent.click(screen.getAllByTestId('environment-row')[0]!);
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'env:globals', kind: 'environment', title: 'Globals', environmentId: 'globals' },
    ]);
  });

  it('marks the row the active editor tab is editing, and only that row', () => {
    setUp();
    fireEvent.click(screen.getAllByTestId('environment-row')[3]!);
    const rows = screen.getAllByTestId('environment-row');
    expect(rows.map((row) => row.dataset['open'])).toEqual(['false', 'false', 'false', 'true']);
    expect(rows[3]?.getAttribute('aria-current')).toBe('page');
  });

  it('leaves every row unmarked while the active tab is not an environment', () => {
    setUp();
    useEditorsStore.getState().open({ id: 'r1', kind: 'request', title: 'Add', requestId: 'r1' });
    const rows = screen.getAllByTestId('environment-row');
    expect(rows.every((row) => row.dataset['open'] === 'false')).toBe(true);
  });

  it('does not open a tab when a click lands on the set-active control', () => {
    setUp();
    const uatRow = screen.getAllByTestId('environment-row')[3]!;
    fireEvent.click(uatRow.querySelector('button[aria-label="Set uat active"]')!);
    expect(useEditorsStore.getState().tabs).toEqual([]);
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
    useUiStore.setState({ sidebar: { visible: true, view: 'environments', size: 20, lastSize: 20 } });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(useUiStore.getState().sidebar.visible).toBe(false);
  });
});
