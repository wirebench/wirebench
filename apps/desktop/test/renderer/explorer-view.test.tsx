import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ExplorerView, sameProject } from '../../src/renderer/features/explorer/explorer-view.js';
import { startRenamingNode } from '../../src/renderer/features/explorer/explorer-api.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { InterfaceWire, WorkspaceProjectWire, WorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { REQUEST_PROPERTIES, restApiWire, restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';
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
function openWorkspace(projects: readonly WorkspaceProjectWire[], share?: NonNullable<WorkspaceWire['share']>): void {
  useWorkspaceStore.setState({ workspace: workspaceWire(share === undefined ? { projects } : { projects, share }) });
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
    installWirebenchApi();
    useProjectStore.setState({ projects: {}, interfaces: {}, requests: {}, order: [], projectOf: {} });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useUiStore.setState({ selection: undefined, workspaces: {} });
    useSyncStore.getState().reset();
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
    expect(screen.getAllByRole('button', { name: 'Import…' })).toHaveLength(2);
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
          slug: 'Request 1',
          operationSlug: 'Add',
          envelopeXml: '<Envelope/>',
          soapVersion: '1.1',
          headers: [],
          order: 0,
        },
      },
    });
    // Below a project everything starts folded shut; unfold the path down to the request.
    useUiStore.setState({
      workspaces: {
        w1: {
          tabs: [],
          explorerOpen: { 'iface:iface-1': true, 'operations:iface-1': true, 'op:iface-1:{tns}B:Add': true },
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

    // A single click opens the request; nothing about it needs a second one.
    fireEvent.click(requestRow);

    expect(useEditorsStore.getState().tabs).toHaveLength(1);
    expect(useEditorsStore.getState().tabs[0]?.requestId).toBe('req-1');

    // And a second click is idempotent: the same tab is focused, never duplicated.
    fireEvent.click(requestRow);
    expect(useEditorsStore.getState().tabs).toHaveLength(1);
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
    // A single click on a project row also opens its tab immediately, as a normal pinned tab
    // (the approved spec's amendment) — not just a selection.
    expect(useEditorsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: 'project:p2', kind: 'project', projectId: 'p2', title: 'Billing' }),
    ]);
    expect(useEditorsStore.getState().activeId).toBe('project:p2');
  });

  it('badges a project and its conflicted request, but leaves an unrelated request unmarked', () => {
    useProjectStore.setState({
      interfaces: { [summary.id]: summary },
      order: [{ projectId: 'p1', interfaceIds: [summary.id] }],
      projectOf: { [summary.id]: 'p1', 'req-1': 'p1', 'req-2': 'p1' },
      requests: {
        'req-1': {
          properties: REQUEST_PROPERTIES,
          attachments: [],
          id: 'req-1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          slug: 'Request 1',
          operationSlug: 'Add',
          envelopeXml: '<Envelope/>',
          soapVersion: '1.1',
          headers: [],
          order: 0,
        },
        'req-2': {
          properties: REQUEST_PROPERTIES,
          attachments: [],
          id: 'req-2',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 2',
          slug: 'Request 2',
          operationSlug: 'Add',
          envelopeXml: '<Envelope/>',
          soapVersion: '1.1',
          headers: [],
          order: 1,
        },
      },
    });
    useSyncStore.setState({
      conflicts: [
        { path: 'projects/Demo/interfaces/Calculator/operations/Add/Request 1.request.yaml', projectId: 'p1' },
      ],
    });
    useUiStore.setState({
      workspaces: {
        w1: {
          tabs: [],
          explorerOpen: { 'iface:iface-1': true, 'operations:iface-1': true, 'op:iface-1:{tns}B:Add': true },
        },
      },
    });

    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    const badges = screen.getAllByTestId('explorer-conflict-badge');
    // One on the project row, one on the conflicted request row — never on the unrelated one.
    expect(badges).toHaveLength(2);
    const conflictedRequestRow = screen.getByText('Request 1').closest('[data-testid="explorer-tree-row"]');
    expect(conflictedRequestRow?.querySelector('[data-testid="explorer-conflict-badge"]')).toBeTruthy();
    const otherRequestRow = screen.getByText('Request 2').closest('[data-testid="explorer-tree-row"]');
    expect(otherRequestRow?.querySelector('[data-testid="explorer-conflict-badge"]')).toBeNull();
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

    // An imported interface starts folded shut under its (open) project.
    expect(screen.queryByText('Operations')).toBeNull();

    // An interface row has children, so a single click unfolds it rather than opening a viewer —
    // browsing the tree must not spawn a tab per row it passes through.
    fireEvent.click(interfaceRow);
    expect(useEditorsStore.getState().tabs).toHaveLength(0);
    expect(screen.queryByText('Operations')).toBeTruthy();

    fireEvent.click(interfaceRow);
    expect(screen.queryByText('Operations')).toBeNull();

    // The viewer still answers to a double-click, as it always has.
    fireEvent.doubleClick(interfaceRow);

    expect(useEditorsStore.getState().tabs).toHaveLength(1);
    expect(useEditorsStore.getState().tabs[0]?.id).toBe('interface:iface-1');
  });

  it('remembers what was folded open per workspace and restores it on the next mount', () => {
    useProjectStore.setState({
      interfaces: { [summary.id]: summary },
      order: [{ projectId: 'p1', interfaceIds: [summary.id] }],
      requests: {},
    });

    const view = render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );
    fireEvent.click(screen.getByText('Calculator'));
    expect(useUiStore.getState().workspaces['w1']?.explorerOpen).toMatchObject({ 'iface:iface-1': true });

    view.unmount();
    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByText('Operations')).toBeTruthy();
  });

  describe('Link Project Folder…', () => {
    it('is enabled in a local workspace, and links a project folder when clicked', async () => {
      const linkProject = vi
        .fn()
        .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ projects: [wireProject()] }) } });
      installWirebenchApi({ workspace: { linkProject } });
      render(
        <TooltipPrimitive.Provider>
          <ExplorerView />
        </TooltipPrimitive.Provider>,
      );

      const button = screen.getByTestId('explorer-link-project');
      expect(button.hasAttribute('disabled')).toBe(false);

      await userEvent.click(button);

      await waitFor(() => expect(linkProject).toHaveBeenCalledTimes(1));
    });

    it('is disabled in a shared workspace, with the explanation as its accessible name', () => {
      openWorkspace([wireProject()], { kind: 'git', managed: true });
      render(
        <TooltipPrimitive.Provider>
          <ExplorerView />
        </TooltipPrimitive.Provider>,
      );

      const button = screen.getByTestId('explorer-link-project');
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('aria-label')).toBe(
        'Shared workspaces hold their projects inside the workspace; use Move to workspace…',
      );
    });
  });
});

/**
 * The REST rows. The tests cover what the row *is* (its testid, its badge) and what a click on it
 * does, because both are what the rest of the app addresses the explorer by.
 */
describe('ExplorerView with APIs', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: {},
      interfaces: {},
      requests: {},
      apis: {},
      folders: {},
      restRequests: {},
      rest: {},
      order: [],
    });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useUiStore.setState({ selection: undefined, workspaces: {}, confirmDeleteNode: undefined });
    openWorkspace([wireProject()]);
    globalThis.ResizeObserver = ManualResizeObserver;
  });

  afterEach(() => {
    cleanup();
  });

  /** Mirrors one API with one folder and two requests, and unfolds the whole path. */
  function seedRest(): void {
    useProjectStore.setState({
      order: [{ projectId: 'p1', interfaceIds: [] }],
      rest: {
        p1: {
          apis: [restApiWire()],
          folders: [restFolderWire()],
          requests: [
            restRequestWire({ id: 'rest-root', name: 'At root', method: 'POST', order: 1 }),
            restRequestWire({ id: 'rest-deep', name: 'In folder', folderId: 'folder-1', order: 0 }),
          ],
        },
      },
      apis: { 'api-1': restApiWire() },
      folders: { 'folder-1': restFolderWire() },
      restRequests: {
        'rest-root': restRequestWire({ id: 'rest-root', name: 'At root', method: 'POST', order: 1 }),
        'rest-deep': restRequestWire({ id: 'rest-deep', name: 'In folder', folderId: 'folder-1', order: 0 }),
      },
      projectOf: { p1: 'p1', 'api-1': 'p1', 'folder-1': 'p1', 'rest-root': 'p1', 'rest-deep': 'p1' },
    });
    useUiStore.setState({
      workspaces: { w1: { tabs: [], explorerOpen: { 'api:api-1': true, 'folder:folder-1': true } } },
    });
  }

  function mount(): void {
    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );
  }

  it('renders an API row with a REST badge, a folder row and method-badged request rows', () => {
    seedRest();
    mount();

    expect(screen.getByTestId('api-row').textContent).toContain('Petstore');
    expect(screen.getByTestId('explorer-api-badge').textContent).toBe('REST');
    expect(screen.getByTestId('folder-row').textContent).toContain('Pets');

    const rows = screen.getAllByTestId('rest-request-row');
    expect(rows).toHaveLength(2);
    const badges = screen.getAllByTestId('method-badge');
    expect(badges.map((badge) => badge.getAttribute('data-method'))).toEqual(['GET', 'POST']);
  });

  it('opens a REST request tab on a single click, and the same tab on a second click', () => {
    seedRest();
    mount();

    fireEvent.click(screen.getByText('At root'));

    expect(useEditorsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: 'rest:rest-root', kind: 'rest-request', restRequestId: 'rest-root' }),
    ]);

    fireEvent.click(screen.getByText('At root'));
    expect(useEditorsStore.getState().tabs).toHaveLength(1);
  });

  it('opens the API tab on a single click of the API row, and selects it', () => {
    seedRest();
    mount();

    fireEvent.click(screen.getByText('Petstore'));

    expect(useEditorsStore.getState().tabs).toEqual([
      expect.objectContaining({ id: 'api:api-1', kind: 'api', apiId: 'api-1', title: 'Petstore' }),
    ]);
    expect(useUiStore.getState().selection).toMatchObject({ kind: 'api', apiId: 'api-1' });
  });

  it('carries the API and folder onto the selection, so the creators know where to put things', () => {
    seedRest();
    mount();

    fireEvent.click(screen.getByText('In folder'));

    expect(useUiStore.getState().selection).toMatchObject({
      kind: 'rest-request',
      requestId: 'rest-deep',
      apiId: 'api-1',
      folderId: 'folder-1',
    });
  });

  it('remembers an API and a folder in the fold state, like every other container', () => {
    seedRest();
    mount();

    fireEvent.click(screen.getByText('Petstore'));

    // The click opened the tab and folded the row shut; the fold state records it per workspace.
    expect(useUiStore.getState().workspaces['w1']?.explorerOpen?.['api:api-1']).toBe(false);
  });

  it('enters inline rename mode and commits the rename', async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    installWirebenchApi({ project: { mutate } });
    seedRest();
    mount();

    startRenamingNode('rest-request', 'rest-root');
    const input = await screen.findByDisplayValue('At root');

    fireEvent.change(input, { target: { value: 'Renamed root' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        projectId: 'p1',
        change: {
          kind: 'update-rest-request',
          requestId: 'rest-root',
          patch: { name: 'Renamed root' },
        },
      });
    });
  });

  it('triggers inline rename from right-click context menu Rename option', async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    installWirebenchApi({ project: { mutate } });
    seedRest();
    mount();

    fireEvent.contextMenu(screen.getByText('At root'));
    const renameOption = await screen.findByText('Rename…');
    fireEvent.click(renameOption);

    const input = await screen.findByDisplayValue('At root');

    fireEvent.change(input, { target: { value: 'Renamed from menu' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        projectId: 'p1',
        change: {
          kind: 'update-rest-request',
          requestId: 'rest-root',
          patch: { name: 'Renamed from menu' },
        },
      });
    });
  });

  it('checks whether drop target and dragged node belong to the same project (1.3)', () => {
    useProjectStore.setState({
      projectOf: {
        'api-1': 'p1',
        'api-2': 'p2',
        'folder-1': 'p1',
        'folder-2': 'p2',
        'req-1': 'p1',
        'req-2': 'p2',
      },
    });

    const nodeA = {
      id: 'rest:req-1',
      kind: 'rest-request',
      label: 'Req 1',
      requestId: 'req-1',
      apiId: 'api-1',
    } as const;
    const nodeB = {
      id: 'folder:folder-1',
      kind: 'folder',
      label: 'Folder 1',
      folderId: 'folder-1',
      apiId: 'api-1',
    } as const;
    const nodeC = {
      id: 'rest:req-2',
      kind: 'rest-request',
      label: 'Req 2',
      requestId: 'req-2',
      apiId: 'api-2',
    } as const;

    expect(sameProject(nodeB, nodeA)).toBe(true);
    expect(sameProject(nodeB, nodeC)).toBe(false);
    expect(sameProject(undefined, nodeA)).toBe(false);
    expect(sameProject(nodeA, undefined)).toBe(false);
  });
});
