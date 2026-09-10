import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { cycleEnvironment, EnvSwitcher } from '../../src/renderer/features/environments/env-switcher.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { EnvironmentWire } from '../../src/shared/wire-types.js';

const dev: EnvironmentWire = { id: 'e1', name: 'dev', slug: 'dev', order: 0, endpoints: {}, properties: {} };
const uat: EnvironmentWire = { id: 'e2', name: 'uat', slug: 'uat', order: 1, endpoints: {}, properties: {} };

function setUp(activeEnvironmentId: string | undefined) {
  const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
  useProjectStore.setState({ environments: [dev, uat], activeEnvironmentId, setActiveEnvironment });
  useUiStore.setState({ envSwitcherOpen: false });
  return setActiveEnvironment;
}

describe('EnvSwitcher', () => {
  afterEach(() => {
    cleanup();
    useProjectStore.setState({ environments: [], activeEnvironmentId: undefined });
    useUiStore.setState({ envSwitcherOpen: false });
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

  it('opens from the ui store, so `env.switch` can drive it', async () => {
    setUp('e1');
    render(<EnvSwitcher />);
    useUiStore.getState().setEnvSwitcherOpen(true);
    expect((await screen.findAllByRole('menuitem')).length).toBeGreaterThan(0);
  });
});

describe('cycleEnvironment', () => {
  afterEach(() => {
    useProjectStore.setState({ environments: [], activeEnvironmentId: undefined });
  });

  it('cycles none -> first -> second -> none', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ environments: [dev, uat], activeEnvironmentId: undefined, setActiveEnvironment });

    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('e1');

    useProjectStore.setState({ activeEnvironmentId: 'e1' });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith('e2');

    useProjectStore.setState({ activeEnvironmentId: 'e2' });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).toHaveBeenLastCalledWith(null);
  });

  it('does nothing when the project has no environments', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ environments: [], activeEnvironmentId: undefined, setActiveEnvironment });
    await cycleEnvironment(1);
    expect(setActiveEnvironment).not.toHaveBeenCalled();
  });
});
