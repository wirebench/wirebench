import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { cycleEnvironment, EnvSwitcher } from '../../src/renderer/features/environments/env-switcher.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
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

function setUp(activeEnvironmentId: string | undefined) {
  const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
  useWorkspaceStore.setState({
    workspace: workspaceWire({
      environments: [dev, uat],
      ...(activeEnvironmentId !== undefined ? { activeEnvironmentId } : {}),
    }),
    setActiveEnvironment,
  });
  useUiStore.setState({ envSwitcherOpen: false });
  return setActiveEnvironment;
}

describe('EnvSwitcher', () => {
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useUiStore.setState({ envSwitcherOpen: false });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  it('shows "No environment" when none is active', () => {
    setUp(undefined);
    render(<EnvSwitcher />);
    expect(screen.getByTestId('env-switcher').textContent).toContain('No environment');
  });

  it('shows the active environment name', () => {
    setUp('e2');
    render(<EnvSwitcher />);
    expect(screen.getByTestId('env-switcher').textContent).toContain('uat');
  });

  it('lists every environment plus "No environment" and switches on select', async () => {
    const setActiveEnvironment = setUp('e1');
    render(<EnvSwitcher />);
    fireEvent.keyDown(screen.getByTestId('env-switcher'), { key: 'Enter' });

    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['dev', 'uat', 'No environment', 'Manage environments…']);

    fireEvent.click(items[1]!);
    await waitFor(() => {
      expect(setActiveEnvironment).toHaveBeenCalledWith('e2');
    });
  });

  it('opens the environments grid from Manage environments, even with none active', async () => {
    setUp(undefined);
    render(<EnvSwitcher />);
    fireEvent.keyDown(screen.getByTestId('env-switcher'), { key: 'Enter' });

    const items = await screen.findAllByRole('menuitem');
    fireEvent.click(items.at(-1)!);

    await waitFor(() => {
      expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['env:e1']);
    });
  });

  it('opens from the ui store, so `env.switch` can drive it', async () => {
    setUp('e1');
    render(<EnvSwitcher />);
    useUiStore.getState().setEnvSwitcherOpen(true);
    expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0);
  });
});

describe('cycleEnvironment', () => {
  afterEach(() => {
    useWorkspaceStore.setState({ workspace: null });
  });

  it('cycles none -> first -> second -> none', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ workspace: workspaceWire({ environments: [dev, uat] }), setActiveEnvironment });

    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('e1');

    useWorkspaceStore.setState({ workspace: workspaceWire({ environments: [dev, uat], activeEnvironmentId: 'e1' }) });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('e2');

    useWorkspaceStore.setState({ workspace: workspaceWire({ environments: [dev, uat], activeEnvironmentId: 'e2' }) });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith(null);
  });

  it('does nothing when the workspace has no environments', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ workspace: workspaceWire(), setActiveEnvironment });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).not.toHaveBeenCalled();
  });
});
