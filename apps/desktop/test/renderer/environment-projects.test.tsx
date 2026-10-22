import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EnvironmentProjects } from '../../src/renderer/features/environments/environment-projects.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import type { EnvironmentWire, WorkspaceEnvironmentWire, WorkspaceProjectWire } from '../../src/shared/wire-base.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const environment: WorkspaceEnvironmentWire = {
  id: 'e1',
  name: 'Billing sandbox',
  slug: 'billing-sandbox',
  order: 0,
  endpoints: {},
  properties: {},
  disabled: [],
};

const project = (id: string, name: string): WorkspaceProjectWire => ({
  id,
  name,
  slug: name.toLowerCase(),
  source: 'internal',
  dir: `/tmp/${id}`,
  status: 'ready',
});

function setUp(env: WorkspaceEnvironmentWire = environment) {
  const mutate = vi.fn().mockResolvedValue({});
  useWorkspaceStore.setState({
    workspace: workspaceWire({ projects: [project('p1', 'Alpha'), project('p2', 'Beta')], environments: [env] }),
    mutate: mutate as unknown as ReturnType<typeof useWorkspaceStore.getState>['mutate'],
  });
  return { mutate };
}

const patched = (projects: readonly string[] | null) => ({
  kind: 'update-workspace-environment',
  environmentId: 'e1',
  patch: { projects },
});

const box = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ workspace: null });
  useProjectStore.getState().reset();
});

describe('EnvironmentProjects (#393)', () => {
  it('shows every project ticked under All projects, and clearing one narrows to the others', async () => {
    const { mutate } = setUp();
    render(<EnvironmentProjects environmentId="e1" />);
    expect(box('All projects').checked).toBe(true);
    expect(box('Applies to Alpha').checked).toBe(true);
    expect(box('Applies to Beta').checked).toBe(true);
    expect(screen.getByTestId('environment-projects-summary').textContent).toBe('Applies to every project.');
    fireEvent.click(box('Applies to Beta'));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched(['p1']));
    });
  });

  it('clearing All projects narrows to every project of the workspace, ticked', async () => {
    const { mutate } = setUp();
    render(<EnvironmentProjects environmentId="e1" />);
    fireEvent.click(box('All projects'));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched(['p1', 'p2']));
    });
  });

  it('ticking All projects on a narrowed environment drops the scope', async () => {
    const { mutate } = setUp({ ...environment, projects: ['p1'] });
    render(<EnvironmentProjects environmentId="e1" />);
    expect(box('All projects').checked).toBe(false);
    expect(box('Applies to Alpha').checked).toBe(true);
    expect(box('Applies to Beta').checked).toBe(false);
    fireEvent.click(box('All projects'));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched(null));
    });
  });

  it('ticks and clears one project of a narrowed environment, keeping an id this machine does not know', async () => {
    const { mutate } = setUp({ ...environment, projects: ['p1', 'not-pulled'] });
    render(<EnvironmentProjects environmentId="e1" />);
    fireEvent.click(box('Applies to Beta'));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched(['p1', 'not-pulled', 'p2']));
    });
    mutate.mockClear();
    fireEvent.click(box('Applies to Alpha'));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched(['not-pulled']));
    });
  });

  it('ticking every project by hand stays narrowed: a project added later is not included', async () => {
    const { mutate } = setUp({ ...environment, projects: ['p1'] });
    render(<EnvironmentProjects environmentId="e1" />);
    fireEvent.click(box('Applies to Beta'));
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(patched(['p1', 'p2']));
    });
    expect(mutate).not.toHaveBeenCalledWith(patched(null));
  });

  it('allows a scope of no project and says so', () => {
    setUp({ ...environment, projects: [] });
    render(<EnvironmentProjects environmentId="e1" />);
    expect(box('All projects').checked).toBe(false);
    expect(box('Applies to Alpha').checked).toBe(false);
    expect(screen.getByTestId('environment-projects-summary').textContent).toBe('Applies to no project.');
  });

  it("offers nothing for a linked project's own environment", () => {
    setUp();
    const own: EnvironmentWire = { ...environment, id: 'e9', name: 'Own' };
    useProjectStore.setState({
      projects: { p1: { id: 'p1', name: 'Alpha', environments: [own] } as unknown as ProjectWire },
      projectOf: { e9: 'p1' },
    });
    render(<EnvironmentProjects environmentId="e9" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('environment-projects-fixed').textContent).toBe('Own belongs to Alpha only.');
  });
});
