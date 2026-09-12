import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { EnvironmentsSection } from '../../src/renderer/features/environments/environments-section.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
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

function setUp() {
  const actions = {
    mutate: vi.fn().mockResolvedValue({}),
    setActiveEnvironment: vi.fn().mockResolvedValue(undefined),
  };
  useWorkspaceStore.setState({
    workspace: workspaceWire({ environments: [dev, uat], activeEnvironmentId: 'e1' }),
    ...actions,
  });
  render(
    <TooltipPrimitive.Provider>
      <EnvironmentsSection />
    </TooltipPrimitive.Provider>,
  );
  return actions;
}

describe('EnvironmentsSection', () => {
  beforeEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('lists the environments and marks the active one', () => {
    setUp();
    const rows = screen.getAllByTestId('environment-row');
    expect(rows.map((row) => row.textContent)).toEqual(['devactive', 'uat']);
    expect(rows[0]?.dataset['active']).toBe('true');
  });

  it('adds an environment through the inline name prompt', async () => {
    const { mutate } = setUp();
    fireEvent.click(screen.getByRole('button', { name: 'Add environment' }));
    const input = screen.getByLabelText('New environment name');
    fireEvent.change(input, { target: { value: 'prod' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({ kind: 'add-workspace-environment', name: 'prod' });
    });
  });

  it('sets the active environment from the context menu', async () => {
    const { setActiveEnvironment } = setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[1]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Set active' }));
    await waitFor(() => {
      expect(setActiveEnvironment).toHaveBeenCalledWith('e2');
    });
  });

  it('opens an environment editor tab on double-click', () => {
    setUp();
    fireEvent.doubleClick(screen.getAllByTestId('environment-row')[1]!);
    expect(useEditorsStore.getState().tabs).toEqual([
      { id: 'env:e2', kind: 'environment', title: 'uat', environmentId: 'e2' },
    ]);
  });

  it('deletes only after the confirmation is accepted', async () => {
    const { mutate } = setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[1]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(mutate).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({ kind: 'remove-workspace-environment', environmentId: 'e2' });
    });
  });
});
