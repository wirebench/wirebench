import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EndpointsTable } from '../../src/renderer/features/environments/endpoints-table.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type {
  EnvironmentWire,
  InterfaceWire,
  ProjectWire,
  WorkspaceEnvironmentWire,
} from '../../src/shared/wire-types.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const iface: InterfaceWire = {
  id: 'iface-1',
  name: 'Calculator',
  slug: 'calculator',
  endpoints: [{ id: 'ep-1', name: 'Soap', url: 'http://one.test/soap' }],
} as unknown as InterfaceWire;

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ workspace: null });
  useProjectStore.getState().reset();
});

describe('EndpointsTable — workspace environment', () => {
  const environment: WorkspaceEnvironmentWire = {
    id: 'e1',
    name: 'uat',
    slug: 'uat',
    order: 0,
    endpoints: {},
    properties: {},
    disabled: [],
  };

  function setUp(env: WorkspaceEnvironmentWire = environment) {
    // Simulates main echoing an `update-workspace-environment` patch back into the mirror —
    // `queueEndpointOverride` awaits `mutate` and reads the store fresh afterwards.
    const mutate = vi.fn((change: { kind: string; environmentId?: string; patch?: object }) => {
      if (change.kind === 'update-workspace-environment') {
        const current = useWorkspaceStore.getState().workspace;
        if (current !== null) {
          const environments = current.environments.map((candidate) =>
            candidate.id === change.environmentId ? { ...candidate, ...change.patch } : candidate,
          );
          useWorkspaceStore.setState({ workspace: { ...current, environments } });
        }
      }
      return Promise.resolve({});
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [env],
        projects: [{ id: 'p1', name: 'Demo', slug: 'demo', source: 'internal', dir: '/tmp/demo', status: 'ready' }],
      }),
      mutate: mutate as unknown as ReturnType<typeof useWorkspaceStore.getState>['mutate'],
    });
    useProjectStore.setState({
      projects: { p1: { id: 'p1', name: 'Demo', environments: [] } as unknown as ProjectWire },
      interfaces: { 'iface-1': iface },
      order: [{ projectId: 'p1', interfaceIds: ['iface-1'] }],
    });
    render(<EndpointsTable environmentId={env.id} />);
  }

  it('shows one row per interface under a per-project group header, not a label on every row', () => {
    setUp();
    const group = screen.getByTestId('env-endpoints-group');
    expect(group.textContent).toBe('Demo');
    expect(group.getAttribute('scope')).toBe('colgroup');
    expect(screen.getByRole('rowheader', { name: 'Calculator' })).toBeTruthy();
    expect(screen.queryByText('Demo › Calculator')).toBeNull();
    // The project stays in the field's accessible name, so the row is still unambiguous.
    expect(screen.getByLabelText('Endpoint override for Demo › Calculator')).toBeTruthy();
  });

  it('offers the interface addresses as suggestions', () => {
    setUp();
    expect(screen.getByRole('option', { hidden: true }).getAttribute('value')).toBe('http://one.test/soap');
  });

  it('commits an override on Enter, keyed by project/interface slug', async () => {
    setUp();
    const input = screen.getByLabelText('Endpoint override for Demo › Calculator');
    fireEvent.change(input, { target: { value: 'http://two.test/soap' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().workspace?.environments[0]?.endpoints['demo/calculator']).toBe(
        'http://two.test/soap',
      );
    });
  });

  it('clearing the override removes the key', async () => {
    setUp({ ...environment, endpoints: { 'demo/calculator': 'http://two.test/soap' } });
    const input = screen.getByLabelText('Endpoint override for Demo › Calculator');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().workspace?.environments[0]?.endpoints).toEqual({});
    });
  });

  it('labels the effective source', () => {
    setUp({ ...environment, endpoints: { 'demo/calculator': 'http://two.test/soap' } });
    expect(screen.getByTestId('workspace-env-source').textContent).toBe('workspace');
  });
});

describe('EndpointsTable — project environment', () => {
  const environment: EnvironmentWire = {
    id: 'e1',
    name: 'uat',
    slug: 'uat',
    order: 0,
    endpoints: { calculator: 'http://two.test/soap' },
    properties: {},
    disabled: [],
  };

  function setUp() {
    const updateEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      projects: { p1: { id: 'p1', name: 'Demo', environments: [environment] } as unknown as ProjectWire },
      projectOf: { e1: 'p1' },
      interfaces: { 'iface-1': iface },
      order: [{ projectId: 'p1', interfaceIds: ['iface-1'] }],
      updateEnvironment,
    });
    render(<EndpointsTable environmentId="e1" />);
    return updateEnvironment;
  }

  it("shows only the owning project's interfaces, keyed by slug", () => {
    setUp();
    const input = screen.getByLabelText<HTMLInputElement>('Endpoint override for Demo › Calculator');
    expect(input.value).toBe('http://two.test/soap');
  });

  it("does not show a source badge — nothing else contends for this environment's own override", () => {
    setUp();
    expect(screen.queryByTestId('workspace-env-source')).toBeNull();
  });

  it('replaces the whole endpoint map on commit', () => {
    const updateEnvironment = setUp();
    const input = screen.getByLabelText('Endpoint override for Demo › Calculator');
    fireEvent.change(input, { target: { value: 'http://three.test/soap' } });
    fireEvent.blur(input);
    expect(updateEnvironment).toHaveBeenCalledWith('p1', 'e1', { endpoints: { calculator: 'http://three.test/soap' } });
  });
});
