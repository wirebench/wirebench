import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { effectiveEndpointSource, EnvironmentGrid } from '../../src/renderer/features/environments/environment-grid.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type {
  EnvironmentWire,
  InterfaceWire,
  ProjectWire,
  WorkspaceEnvironmentWire,
  WorkspaceProjectWire,
} from '../../src/shared/wire-types.js';

const dev: WorkspaceEnvironmentWire = {
  id: 'e1',
  name: 'dev',
  slug: 'dev',
  order: 0,
  properties: { host: 'dev.test' },
  endpoints: { 'demo/calculator': 'http://dev.test/soap' },
  disabled: [],
};
const uat: WorkspaceEnvironmentWire = {
  id: 'e2',
  name: 'uat',
  slug: 'uat',
  order: 1,
  properties: {},
  endpoints: {},
  disabled: [],
};

const calculator = {
  id: 'iface-1',
  name: 'Calculator',
  slug: 'calculator',
  endpoints: [{ id: 'ep-1', name: 'Soap', url: 'http://declared.test/soap' }],
} as unknown as InterfaceWire;
const weather = {
  id: 'iface-2',
  name: 'Weather',
  slug: 'weather',
  endpoints: [{ id: 'ep-2', name: 'Soap', url: 'http://weather.test/soap' }],
} as unknown as InterfaceWire;

/** The grid's property table renders a Radix tooltip, which needs a provider above it. */
function renderGrid(node: ReactNode): void {
  render(<TooltipPrimitive.Provider>{node}</TooltipPrimitive.Provider>);
}

function project(id: string, name: string, slug: string, source: 'internal' | 'linked'): WorkspaceProjectWire {
  return { id, name, slug, source, dir: `/w/projects/${slug}`, status: 'ready' };
}

function mirrored(id: string, name: string, environments: readonly EnvironmentWire[] = []): ProjectWire {
  return { id, name, environments: [...environments] } as unknown as ProjectWire;
}

/** Two projects, one interface each, and both environments as columns. */
function setUp(options: { readonly projectEnvironments?: readonly EnvironmentWire[] } = {}) {
  const mutate = vi.fn().mockResolvedValue({});
  useWorkspaceStore.setState({
    workspace: workspaceWire({
      environments: [dev, uat],
      projects: [project('p1', 'Demo', 'demo', 'internal'), project('p2', 'Linked', 'linked', 'linked')],
    }),
    mutate,
  });
  useProjectStore.setState({
    projects: {
      p1: mirrored('p1', 'Demo'),
      p2: mirrored('p2', 'Linked', options.projectEnvironments ?? []),
    },
    interfaces: { 'iface-1': calculator, 'iface-2': weather },
    order: [
      { projectId: 'p1', interfaceIds: ['iface-1'] },
      { projectId: 'p2', interfaceIds: ['iface-2'] },
    ],
  });
  renderGrid(<EnvironmentGrid environmentId="e1" />);
  return mutate;
}

describe('EnvironmentGrid', () => {
  afterEach(() => {
    cleanup();
    useProjectStore.getState().reset();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('renders a row per interface across both projects and a column per environment', () => {
    setUp();

    const grid = screen.getByTestId('workspace-env-grid');
    expect(grid.textContent).toContain('Demo › Calculator');
    expect(grid.textContent).toContain('Linked › Weather');
    // Two rows × two environments.
    expect(screen.getAllByTestId('workspace-env-cell')).toHaveLength(4);
    expect(screen.getByLabelText<HTMLInputElement>('Endpoint override for Demo › Calculator in dev').value).toBe(
      'http://dev.test/soap',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Endpoint override for Demo › Calculator in uat').value).toBe('');
  });

  it('offers the interface addresses as suggestions', () => {
    setUp();
    const options = screen.getAllByRole('option', { hidden: true }).map((option) => option.getAttribute('value'));
    expect(options).toContain('http://declared.test/soap');
  });

  it('sends the whole endpoint map with one key changed', async () => {
    const mutate = setUp();
    const field = screen.getByLabelText('Endpoint override for Linked › Weather in dev');
    fireEvent.change(field, { target: { value: 'http://edited.test/soap' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e1',
        patch: {
          endpoints: { 'demo/calculator': 'http://dev.test/soap', 'linked/weather': 'http://edited.test/soap' },
        },
      });
    });
  });

  it('drops the key when a cell is cleared', async () => {
    const mutate = setUp();
    const field = screen.getByLabelText('Endpoint override for Demo › Calculator in dev');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e1',
        patch: { endpoints: {} },
      });
    });
  });

  it('queues two quick edits of one environment so neither is lost', async () => {
    let resolveFirst: (() => void) | undefined;
    const mutate = vi.fn().mockImplementation(async () => {
      if (resolveFirst === undefined) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {};
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({ environments: [dev], projects: [project('p1', 'Demo', 'demo', 'internal')] }),
      mutate,
    });
    useProjectStore.setState({
      projects: { p1: mirrored('p1', 'Demo') },
      interfaces: { 'iface-1': calculator, 'iface-2': weather },
      order: [{ projectId: 'p1', interfaceIds: ['iface-1', 'iface-2'] }],
    });
    renderGrid(<EnvironmentGrid environmentId="e1" />);

    const first = screen.getByLabelText('Endpoint override for Demo › Calculator in dev');
    fireEvent.change(first, { target: { value: 'http://one.test/soap' } });
    fireEvent.keyDown(first, { key: 'Enter' });

    // Fired before the first round trip resolves: it must build on what the first wrote, not on
    // the map as it was when the cell rendered.
    const second = screen.getByLabelText('Endpoint override for Demo › Weather in dev');
    fireEvent.change(second, { target: { value: 'http://two.test/soap' } });
    fireEvent.keyDown(second, { key: 'Enter' });

    await waitFor(() => {
      expect(resolveFirst).toBeDefined();
    });
    expect(mutate).toHaveBeenCalledTimes(1);

    // Main answers the first edit; the store now holds it, as the real store would.
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [{ ...dev, endpoints: { 'demo/calculator': 'http://one.test/soap' } }],
        projects: [project('p1', 'Demo', 'demo', 'internal')],
      }),
      mutate,
    });
    resolveFirst?.();

    await waitFor(() => {
      expect(mutate).toHaveBeenLastCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e1',
        patch: {
          endpoints: { 'demo/calculator': 'http://one.test/soap', 'demo/weather': 'http://two.test/soap' },
        },
      });
    });
  });

  it('labels each cell with the layer that actually wins', () => {
    setUp({
      projectEnvironments: [
        {
          id: 'pe1',
          name: 'dev',
          slug: 'dev',
          order: 0,
          properties: {},
          endpoints: { weather: 'http://own.test' },
          disabled: [],
        },
      ],
    });

    const sourceOf = (label: string): string | null =>
      screen.getByLabelText(label).closest('td')!.getAttribute('data-source');

    // The linked project's own `dev` environment overrides Weather — it wins over the workspace's.
    expect(sourceOf('Endpoint override for Linked › Weather in dev')).toBe('project');
    // The workspace environment's own override, with no project environment above it.
    expect(sourceOf('Endpoint override for Demo › Calculator in dev')).toBe('workspace');
    // Nothing overrides it: the interface's declared address is what a send would use.
    expect(sourceOf('Endpoint override for Demo › Calculator in uat')).toBe('interface');
  });

  it('edits the selected environment’s properties through the same channel', async () => {
    const mutate = setUp();
    expect(screen.getByLabelText<HTMLInputElement>('Value of host').value).toBe('dev.test');

    fireEvent.click(screen.getByRole('button', { name: 'uat', pressed: false }));
    expect(screen.queryByLabelText('Value of host')).toBeNull();

    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        kind: 'update-workspace-environment',
        environmentId: 'e2',
        patch: { properties: { port: '8080' } },
      });
    });
  });

  it('says so when the workspace has no environments yet', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    renderGrid(<EnvironmentGrid environmentId="e1" />);
    expect(screen.getByTestId('workspace-env-grid').textContent).toContain('No environments yet');
  });
});

describe('effectiveEndpointSource', () => {
  it('puts a linked project environment above the workspace one, and that above the interface', () => {
    expect(
      effectiveEndpointSource({
        projectOverride: 'http://p',
        workspaceOverride: 'http://w',
        interfaceDefault: 'http://i',
      }),
    ).toBe('project');
    expect(effectiveEndpointSource({ workspaceOverride: 'http://w', interfaceDefault: 'http://i' })).toBe('workspace');
    expect(effectiveEndpointSource({ interfaceDefault: 'http://i' })).toBe('interface');
    expect(effectiveEndpointSource({})).toBe('none');
  });
});
