import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  EnvironmentDetails,
  useEnvironmentDetailsStore,
} from '../../src/renderer/features/environments/environment-details.js';
import { EnvironmentPage } from '../../src/renderer/features/environments/environment-page.js';
import { RightRail } from '../../src/renderer/shell/right-rail.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import type { EnvironmentWire, WorkspaceEnvironmentWire } from '../../src/shared/wire-base.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const environment: WorkspaceEnvironmentWire = {
  id: 'e1',
  name: 'prod',
  slug: 'prod',
  order: 0,
  endpoints: {},
  properties: { host: 'one.test', token: 'abc' },
  disabled: [],
};

function setUpWorkspace(env: WorkspaceEnvironmentWire = environment) {
  const mutate = vi.fn().mockResolvedValue({});
  useWorkspaceStore.setState({
    workspace: workspaceWire({
      projects: [{ id: 'p1', name: 'Billing', slug: 'billing', source: 'internal', dir: '/tmp/b', status: 'ready' }],
      environments: [env],
    }),
    lastProjectId: 'p1',
    mutate: mutate as unknown as ReturnType<typeof useWorkspaceStore.getState>['mutate'],
  });
  return { mutate };
}

const patched = (patch: object) => ({ kind: 'update-workspace-environment', environmentId: 'e1', patch });

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ workspace: null, lastProjectId: undefined });
  useProjectStore.getState().reset();
  useEditorsStore.setState({ tabs: [], activeId: undefined, displayedSet: 'explorer', activeBySet: {} });
  useEnvironmentDetailsStore.setState({ open: true });
});

describe('EnvironmentDetails — a workspace environment', () => {
  it('shows the name, scope and variable count', () => {
    setUpWorkspace();
    render(<EnvironmentDetails environmentId="e1" />);
    expect(screen.getByTestId('environment-details-name').textContent).toBe('prod');
    expect(screen.getByText('Workspace environment')).toBeTruthy();
    expect(screen.getByTestId('environment-details-variables').textContent).toBe('2 variables');
  });

  it('changes the colour through the environment update path', async () => {
    const { mutate } = setUpWorkspace();
    render(<EnvironmentDetails environmentId="e1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Colour red' }));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched({ color: 'red' }));
    });
  });

  it('narrows Applies to through the same path', async () => {
    const { mutate } = setUpWorkspace();
    render(<EnvironmentDetails environmentId="e1" />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'All projects' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Selected projects' }));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched({ projects: ['p1'] }));
    });
  });

  it('shows a protected environment ticked, and unticking it drops the flag', async () => {
    const { mutate } = setUpWorkspace({ ...environment, protected: true });
    render(<EnvironmentDetails environmentId="e1" />);
    const box = screen.getByLabelText<HTMLInputElement>('Protected');
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched({ protected: false }));
    });
  });

  it('labels every control and lets Tab reach them', () => {
    setUpWorkspace();
    render(<EnvironmentDetails environmentId="e1" />);
    expect(screen.getByRole('group', { name: 'Colour of prod' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Applies to' })).toBeTruthy();
    for (const control of screen.getAllByRole('button').concat(screen.getAllByRole('radio'))) {
      expect(control.getAttribute('tabindex')).not.toBe('-1');
    }
  });
});

describe("EnvironmentDetails — a linked project's own environment", () => {
  const own: EnvironmentWire = { ...environment, properties: { host: 'one.test' } };

  it('saves through the project store and has no scope to choose', () => {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      projects: { p1: { id: 'p1', name: 'Demo', environments: [own] } as unknown as ProjectWire },
      projectOf: { e1: 'p1' },
      updateEnvironment,
    });
    render(<EnvironmentDetails environmentId="e1" />);
    expect(screen.getByTestId('environment-details-variables').textContent).toBe('1 variable');
    expect(screen.queryByRole('radio', { name: 'All projects' })).toBeNull();
    expect(screen.getByTestId('environment-applies-to-fixed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Colour orange' }));
    expect(updateEnvironment).toHaveBeenCalledWith('p1', 'e1', { color: 'orange' });
    fireEvent.click(screen.getByLabelText('Protected'));
    expect(updateEnvironment).toHaveBeenCalledWith('p1', 'e1', { protected: true });
  });
});

describe('the environment page without its panel', () => {
  it('no longer carries colour or Applies to in its header', () => {
    setUpWorkspace();
    render(
      <TooltipPrimitive.Provider>
        <EnvironmentPage target={{ kind: 'environment', id: 'e1' }} />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.queryByTestId('environment-look')).toBeNull();
    expect(screen.queryByTestId('environment-applies-to')).toBeNull();
  });
});

describe('the right rail in the Environments area', () => {
  beforeEach(() => {
    setUpWorkspace();
  });

  function renderRail() {
    render(
      <TooltipPrimitive.Provider>
        <RightRail platform="mac" />
      </TooltipPrimitive.Provider>,
    );
  }

  it('offers Environment details for an open environment and toggles it', () => {
    useEditorsStore.setState({
      tabs: [{ id: 'env:e1', kind: 'environment', title: 'prod', environmentId: 'e1' }] as never,
      activeId: 'env:e1',
      displayedSet: 'explorer',
    });
    renderRail();
    const icon = screen.getByTestId('rail-environment-details');
    expect(screen.queryByTestId('rail-code')).toBeNull();
    expect(icon.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(icon);
    expect(useEnvironmentDetailsStore.getState().open).toBe(false);
    expect(icon.getAttribute('aria-expanded')).toBe('false');
  });

  it('disables it on Globals, which has no colour or scope', () => {
    useEditorsStore.setState({
      tabs: [{ id: 'env:globals', kind: 'environment', title: 'Globals', environmentId: 'globals' }] as never,
      activeId: 'env:globals',
      displayedSet: 'explorer',
    });
    renderRail();
    expect(screen.getByTestId<HTMLButtonElement>('rail-environment-details').disabled).toBe(true);
  });
});
