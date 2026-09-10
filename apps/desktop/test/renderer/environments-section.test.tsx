import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { EnvironmentsSection } from '../../src/renderer/features/environments/environments-section.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { EnvironmentWire, ProjectWire } from '../../src/shared/wire-types.js';

const dev: EnvironmentWire = { id: 'e1', name: 'dev', slug: 'dev', order: 0, endpoints: {}, properties: {} };
const uat: EnvironmentWire = { id: 'e2', name: 'uat', slug: 'uat', order: 1, endpoints: {}, properties: {} };

const project = {
  id: 'p1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  environments: [dev, uat],
  problems: [],
} as unknown as ProjectWire;

function setUp(overrides: Partial<ReturnType<typeof useProjectStore.getState>> = {}) {
  const actions = {
    addEnvironment: vi.fn().mockResolvedValue('e3'),
    updateEnvironment: vi.fn().mockResolvedValue(undefined),
    removeEnvironment: vi.fn().mockResolvedValue(undefined),
    setActiveEnvironment: vi.fn().mockResolvedValue(undefined),
  };
  useProjectStore.setState({
    project,
    environments: [dev, uat],
    activeEnvironmentId: 'e1',
    ...actions,
    ...overrides,
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
    useProjectStore.setState({ project: null, environments: [], activeEnvironmentId: undefined });
  });

  it('lists the environments and marks the active one', () => {
    setUp();
    const rows = screen.getAllByTestId('environment-row');
    expect(rows.map((row) => row.textContent)).toEqual(['devactive', 'uat']);
    expect(rows[0]?.dataset['active']).toBe('true');
  });

  it('adds an environment through the inline name prompt', async () => {
    const { addEnvironment } = setUp();
    fireEvent.click(screen.getByRole('button', { name: 'Add environment' }));
    const input = screen.getByLabelText('New environment name');
    fireEvent.change(input, { target: { value: 'prod' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(addEnvironment).toHaveBeenCalledWith('prod');
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
    const { removeEnvironment } = setUp();
    fireEvent.contextMenu(screen.getAllByTestId('environment-row')[1]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(removeEnvironment).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(removeEnvironment).toHaveBeenCalledWith('e2');
    });
  });
});
