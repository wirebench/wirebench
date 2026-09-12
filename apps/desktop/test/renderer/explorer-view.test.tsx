import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ExplorerView } from '../../src/renderer/features/explorer/explorer-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { InterfaceWire, WorkspaceProjectWire } from '../../src/shared/wire-types.js';
import { REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

function wireProject(patch: Partial<WorkspaceProjectWire> = {}): WorkspaceProjectWire {
  return {
    id: 'p1',
    name: 'Demo',
    slug: 'Demo',
    source: 'internal',
    dir: '/tmp/workspaces/w1/projects/Demo',
    status: 'ready',
    ...patch,
  };
}

/** Puts `projects` in the open workspace, which is where the tree's roots come from. */
function openWorkspace(projects: readonly WorkspaceProjectWire[]): void {
  useWorkspaceStore.setState({ workspace: workspaceWire({ projects }) });
}

const summary: InterfaceWire = {
  id: 'iface-1',
  name: 'Calculator',
  slug: 'Calculator',
  cacheDefinition: true,
  hydration: 'ready',
  endpoints: [{ id: 'ep-1', name: 'Calculator CalculatorSoap', url: 'http://example.test/soap', authMode: 'override' }],
  defaultEndpointId: 'ep-1',
  definitionUrl: 'http://example.test/service.wsdl',
  targetNamespace: 'http://tempuri.org/',
  soapVersions: ['1.1'],
  services: [
    {
      name: 'Calculator',
      ports: [{ name: 'CalculatorSoap', address: 'http://example.test/soap', binding: '{tns}B', soapVersion: '1.1' }],
    },
  ],
  operations: [
    {
      name: 'Add',
      binding: '{tns}B',
      bindingLocal: 'B',
      soapVersion: '1.1',
      style: 'document',
      ports: [],
      inputMimeParts: [],
    },
  ],
  problems: [],
  documentCount: 1,
};

/** jsdom has no layout, so `ResizeObserver` never fires on its own; drive it manually. */
class ManualResizeObserver {
  static instances: ManualResizeObserver[] = [];
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ManualResizeObserver.instances.push(this);
  }
  observe(): void {
    this.callback([{ contentRect: { width: 300, height: 400 } }] as ResizeObserverEntry[], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

describe('ExplorerView', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: {}, interfaces: {}, requests: {}, order: [] });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useUiStore.setState({ selection: undefined });
    openWorkspace([wireProject()]);
    globalThis.ResizeObserver = ManualResizeObserver;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the empty state, with both ways in, when the workspace has no project', () => {
    openWorkspace([]);
    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByText('No projects yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy();
    // Two of them: the toolbar's icon button, and the empty state's own.
    expect(screen.getAllByRole('button', { name: 'Import WSDL…' })).toHaveLength(2);
  });

  it('renders the tree and opens an editor tab on double-click of a request', () => {
    useProjectStore.setState({
      interfaces: { [summary.id]: summary },
      order: [{ projectId: 'p1', interfaceIds: [summary.id] }],
      requests: {
        'req-1': {
          properties: REQUEST_PROPERTIES,
          attachments: [],
          id: 'req-1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: '<Envelope/>',
          soapVersion: '1.1',
          headers: [],
          order: 0,
        },
      },
    });

    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByText('Calculator')).toBeTruthy();
    expect(screen.getByText('Endpoints')).toBeTruthy();
    expect(screen.getByText('Operations')).toBeTruthy();

    expect(screen.getByTestId('explorer-project-row').getAttribute('data-project-id')).toBe('p1');

    const requestRow = screen.getByText('Request 1');

    // A single click only selects the node — it must not open an editor tab.
    fireEvent.click(requestRow);
    expect(useEditorsStore.getState().tabs).toHaveLength(0);

    fireEvent.doubleClick(requestRow);

    expect(useEditorsStore.getState().tabs).toHaveLength(1);
    expect(useEditorsStore.getState().tabs[0]?.requestId).toBe('req-1');
  });

  it('badges a linked project with its folder, and selects the project on click', () => {
    openWorkspace([
      wireProject(),
      wireProject({ id: 'p2', name: 'Billing', slug: 'Billing', source: 'linked', dir: '/elsewhere/billing' }),
    ]);

    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    const rows = screen.getAllByTestId('explorer-project-row');
    expect(rows.map((row) => row.getAttribute('data-project-id'))).toEqual(['p1', 'p2']);

    const badge = screen.getByTestId('explorer-project-linked-badge');
    expect(badge.getAttribute('title')).toBe('/elsewhere/billing');
    // Only the linked one is badged.
    expect(screen.getAllByTestId('explorer-project-linked-badge')).toHaveLength(1);

    fireEvent.click(screen.getByText('Billing'));
    // The selection names the project id, not the tree node id, so the details panel and the
    // `selection.project` commands can act on it.
    expect(useUiStore.getState().selection).toMatchObject({ kind: 'project', id: 'p2' });
  });

  it('offers Locate… and Remove on a project whose folder is missing', () => {
    openWorkspace([wireProject({ source: 'linked', dir: '/gone', status: 'missing' })]);

    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    const row = screen.getByTestId('explorer-project-missing');
    expect(row.getAttribute('data-project-id')).toBe('p1');
    expect(row.textContent).toContain('This project folder is missing.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(useUiStore.getState().confirmRemoveProjectId).toBe('p1');
  });

  it('opens the interface viewer on double-click only, never on a single click', () => {
    useProjectStore.setState({
      interfaces: { [summary.id]: summary },
      order: [{ projectId: 'p1', interfaceIds: [summary.id] }],
      requests: {},
    });

    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    const interfaceRow = screen.getByText('Calculator');

    // react-arborist's own row wrapper activates on any click that reaches it, so the row
    // handler stops propagation; a single click must only select.
    fireEvent.click(interfaceRow);
    expect(useEditorsStore.getState().tabs).toHaveLength(0);

    fireEvent.doubleClick(interfaceRow);

    expect(useEditorsStore.getState().tabs).toHaveLength(1);
    expect(useEditorsStore.getState().tabs[0]?.id).toBe('interface:iface-1');
  });
});
