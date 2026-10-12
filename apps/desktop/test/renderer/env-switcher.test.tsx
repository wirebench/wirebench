import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { cycleEnvironment, EnvSwitcher } from '../../src/renderer/features/environments/env-switcher.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import type { WorkspaceEnvironmentWire, WorkspaceProjectWire } from '../../src/shared/wire-base.js';
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

const P1: WorkspaceProjectWire = {
  id: 'p1',
  name: 'Billing',
  slug: 'billing',
  source: 'internal',
  dir: '/tmp/b',
  status: 'ready',
};
const P2: WorkspaceProjectWire = {
  id: 'p2',
  name: 'Crm',
  slug: 'crm',
  source: 'internal',
  dir: '/tmp/c',
  status: 'ready',
};

/** A workspace of two projects where `p1` is current (#468), with `activeEnvironmentId` active for it. */
function workspaceFor(activeEnvironmentId: string | undefined, environments = [dev, uat]) {
  return workspaceWire({
    projects: [P1, P2],
    environments,
    activeEnvironments: activeEnvironmentId !== undefined ? { p1: activeEnvironmentId } : {},
  });
}

function setUp(activeEnvironmentId: string | undefined) {
  const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
  useWorkspaceStore.setState({
    workspace: workspaceFor(activeEnvironmentId),
    setActiveEnvironment,
    lastProjectId: 'p1',
  });
  useUiStore.setState({ envSwitcherOpen: false });
  return setActiveEnvironment;
}

describe('EnvSwitcher', () => {
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null, lastProjectId: undefined });
    useUiStore.setState({ envSwitcherOpen: false });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  it('shows "No environment" when none is active', () => {
    setUp(undefined);
    render(<EnvSwitcher />);
    expect(screen.getByTestId('env-switcher').textContent).toContain('No environment');
  });

  it("shows the active environment's colour, and a lock when it is protected", () => {
    setUp('e2');
    const workspace = useWorkspaceStore.getState().workspace;
    useWorkspaceStore.setState({
      workspace: workspace && {
        ...workspace,
        environments: [dev, { ...uat, color: 'red', protected: true }],
      },
    });
    render(<EnvSwitcher />);
    const trigger = screen.getByTestId('env-switcher');
    const dot = trigger.querySelector<HTMLElement>('[data-testid="env-color-dot"]');
    expect(dot?.style.getPropertyValue('--env-color')).toBe('var(--wb-env-red)');
    expect(trigger.querySelector('[aria-label="Protected environment"]')).not.toBeNull();
  });

  it('shows no dot or lock for an environment with neither', () => {
    setUp('e1');
    render(<EnvSwitcher />);
    const trigger = screen.getByTestId('env-switcher');
    expect(trigger.querySelector('[data-testid="env-color-dot"]')).toBeNull();
    expect(trigger.querySelector('[aria-label="Protected environment"]')).toBeNull();
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
      expect(setActiveEnvironment).toHaveBeenCalledWith('p1', 'e2');
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

  it("lists only the current project's environments, and shows that project's active one (#468)", async () => {
    setUp(undefined);
    useWorkspaceStore.setState({
      workspace: {
        ...workspaceFor('e2', [dev, { ...uat, projects: ['p2'] }]),
        activeEnvironments: { p1: 'e1', p2: 'e2' },
      },
    });
    render(<EnvSwitcher />);
    expect(screen.getByTestId('env-switcher').textContent).toContain('dev');
    fireEvent.keyDown(screen.getByTestId('env-switcher'), { key: 'Enter' });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['dev', 'No environment', 'Manage environments…']);
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
    useWorkspaceStore.setState({ workspace: null, lastProjectId: undefined });
  });

  it('cycles none -> first -> second -> none, for the current project', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ workspace: workspaceFor(undefined), setActiveEnvironment, lastProjectId: 'p1' });

    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('p1', 'e1');

    useWorkspaceStore.setState({ workspace: workspaceFor('e1') });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('p1', 'e2');

    useWorkspaceStore.setState({ workspace: workspaceFor('e2') });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('p1', null);
  });

  it('walks only the environments that apply to the current project', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      workspace: workspaceFor('e1', [dev, { ...uat, projects: ['p2'] }]),
      setActiveEnvironment,
      lastProjectId: 'p1',
    });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('p1', null);
  });

  it('does nothing with no current project', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ workspace: workspaceFor(undefined), setActiveEnvironment, lastProjectId: undefined });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).not.toHaveBeenCalled();
  });

  it('does nothing when the workspace has no environments', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ workspace: workspaceFor(undefined, []), setActiveEnvironment, lastProjectId: 'p1' });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).not.toHaveBeenCalled();
  });
});
