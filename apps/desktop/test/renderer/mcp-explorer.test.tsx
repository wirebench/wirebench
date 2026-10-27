/**
 * MCP in the explorer (#79): the server and request rows and their badges, the menus, the
 * catalogue refresh and *New request from tool…*, and the *New MCP server…* dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { explorerMenuGroups, explorerMenuItems } from '../../src/renderer/features/explorer/context-menu.js';
import { explorerActions, refreshSummary } from '../../src/renderer/features/explorer/explorer-actions.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
import { buildExplorerTree } from '../../src/renderer/features/explorer/tree-nodes.js';
import { McpBadge } from '../../src/renderer/features/mcp-editor/badge.js';
import { mcpMethodLabel } from '../../src/renderer/features/mcp-editor/method-label.js';
import { NewMcpServerDialog, transportOf } from '../../src/renderer/features/mcp-api/new-server-dialog.js';
import { useNewMcpServerDialog } from '../../src/renderer/features/mcp-api/new-server-dialog-state.js';
import { McpToolPickerDialog, toolMatches } from '../../src/renderer/features/mcp-api/tool-picker-dialog.js';
import { useMcpToolPicker } from '../../src/renderer/features/mcp-api/tool-picker-state.js';
import { McpHistoryBody, mcpOutcome } from '../../src/renderer/kinds/mcp/history-body.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { HistoryEntryWire } from '@wirebench/wire/wire-types';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { mcpRequestWire, mcpServerWire, restFolderWire } from '../helpers/wire-defaults.js';

const PROJECT = { id: 'p1', name: 'Demo', source: 'internal', dir: '/ws/demo', status: 'ready' } as const;

function node(patch: Partial<ExplorerNode> & Pick<ExplorerNode, 'kind'>): ExplorerNode {
  return { id: 'n1', label: 'Node', ...patch };
}

const CATALOGUE = {
  tools: [
    { name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object' } },
    { name: 'list_dir', title: 'List directory', inputSchema: { type: 'object' } },
  ],
};

beforeEach(() => {
  showToast.mockClear();
  installWirebenchApi();
  useEditorsStore.setState({ tabs: [], activeId: undefined });
  useNewMcpServerDialog.getState().close();
  useMcpToolPicker.getState().close();
});

afterEach(() => {
  cleanup();
});

describe('MCP rows in the explorer tree', () => {
  it('places a server among the containers, with its folders and requests and their methods', () => {
    const server = mcpServerWire({ id: 's1', order: 0 });
    const folder = restFolderWire({ id: 'f1', apiId: 's1', name: 'Files', order: 0 });
    const call = mcpRequestWire({
      id: 'r1',
      apiId: 's1',
      name: 'Read',
      order: 1,
      operation: { method: 'tools/call', tool: 'read_file', arguments: '' },
    });
    const inFolder = mcpRequestWire({ id: 'r2', apiId: 's1', folderId: 'f1', name: 'List' });
    const [root] = buildExplorerTree(
      [PROJECT],
      [{ projectId: 'p1', interfaceIds: [] }],
      {},
      [],
      { p1: { apis: [], folders: [folder], requests: [] } },
      undefined,
      {},
      {},
      {},
      undefined,
      {},
      {},
      {},
      {},
      { p1: { servers: [server], requests: [call, inFolder] } },
    );

    const serverNode = root?.children?.[0];
    expect(serverNode).toMatchObject({ id: 'mcp-api:s1', kind: 'mcp-api', apiId: 's1', label: 'Files' });
    expect(serverNode?.children?.map((child) => child.id)).toEqual(['folder:f1', 'mcp:r1']);
    expect(serverNode?.children?.[0]?.ownerKind).toBe('mcp');
    expect(serverNode?.children?.[1]).toMatchObject({ kind: 'mcp-request', method: 'tools/call', requestId: 'r1' });
    expect(serverNode?.children?.[0]?.children?.[0]).toMatchObject({
      id: 'mcp:r2',
      method: 'tools/list',
      folderId: 'f1',
    });
  });

  it('badges a request with its method’s short form', () => {
    expect(['tools/call', 'resources/read', 'prompts/get'].map(mcpMethodLabel)).toEqual(['CALL', 'READ', 'GET']);
    expect(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'].map(mcpMethodLabel)).toEqual([
      'LIST',
      'LIST',
      'LIST',
      'LIST',
    ]);
    render(<McpBadge method="resources/read" />);
    expect(screen.getByTestId('mcp-badge').textContent).toBe('READ');
  });
});

describe('MCP menus', () => {
  it('offers New MCP server… on a project, which opens the dialog with a free name', () => {
    useProjectStore.setState({ mcpServers: { s1: mcpServerWire({ id: 's1', name: 'MCP server 1' }) } });
    const item = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }))
      .flatMap((candidate) => candidate.children ?? [])
      .find((candidate) => candidate.key === 'new-mcp-server');
    expect(item?.label).toBe('New MCP server…');
    item?.run();
    expect(useNewMcpServerDialog.getState()).toMatchObject({ projectId: 'p1', suggestedName: 'MCP server 2' });
  });

  it('offers a server its requests, its catalogue and its own lifecycle', () => {
    const groups = explorerMenuGroups(node({ kind: 'mcp-api', id: 'mcp-api:s1', apiId: 's1' }));
    expect(groups.map((group) => group.map((item) => item.label))).toEqual([
      ['Open', 'New folder', 'New request', 'New request from tool…'],
      ['Run…'],
      ['Refresh catalogue'],
      ['Export as Postman Collection…', 'Export as OpenCollection…'],
      ['Rename…', 'Move to project…'],
      ['Delete'],
    ]);
  });

  it('offers a request duplicate, rename and delete; nothing for a row without its ids', () => {
    expect(
      explorerMenuItems(node({ kind: 'mcp-request', id: 'mcp:r1', apiId: 's1', requestId: 'r1' })).map(
        (item) => item.label,
      ),
    ).toEqual(['Duplicate', 'Rename…', 'Delete']);
    expect(explorerMenuItems(node({ kind: 'mcp-api' }))).toEqual([]);
    expect(explorerMenuItems(node({ kind: 'mcp-request', apiId: 's1' }))).toEqual([]);
  });

  it('offers a folder in a server New request, which makes an MCP request there', () => {
    const addMcpRequest = vi.fn().mockResolvedValue('r9');
    useProjectStore.setState({ addMcpRequest, mcpRequests: {} });
    explorerMenuItems(node({ kind: 'folder', id: 'folder:f1', apiId: 's1', folderId: 'f1', ownerKind: 'mcp' }))
      .find((item) => item.label === 'New request')
      ?.run();
    expect(addMcpRequest).toHaveBeenCalledWith('s1', 'f1');
  });

  it('deletes a server at once when it is empty and deletes are not confirmed', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES_WIRE, ui: { ...DEFAULT_PREFERENCES_WIRE.ui, confirmOnDelete: false } },
      loaded: true,
    });
    const removeMcpServer = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ mcpServers: { s1: mcpServerWire({ id: 's1' }) }, mcpRequests: {}, removeMcpServer });
    explorerActions.removeMcpApi('s1');
    expect(removeMcpServer).toHaveBeenCalledWith('s1');
  });
});

describe('Refresh catalogue', () => {
  it('says what the refresh found', async () => {
    const refreshMcpCatalogue = vi.fn().mockResolvedValue({
      projectId: 'p1',
      info: { fetchedAt: 'now', serverInfo: { name: 'files', version: '1' }, protocolVersion: '2025-06-18' },
      counts: { tools: 2, resources: 1, resourceTemplates: 0, prompts: 0 },
      warnings: [],
    });
    useProjectStore.setState({ mcpServers: { s1: mcpServerWire({ id: 's1', name: 'Files' }) }, refreshMcpCatalogue });

    explorerActions.refreshMcpCatalogue('s1');

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Fetched 2 tools and 1 resource from Files');
    });
    expect(refreshMcpCatalogue).toHaveBeenCalledWith('s1');
  });

  it('shows why it failed', async () => {
    const refreshMcpCatalogue = vi.fn().mockRejectedValue(new Error('mcp-server-exited: the server stopped'));
    useProjectStore.setState({ mcpServers: { s1: mcpServerWire({ id: 's1' }) }, refreshMcpCatalogue });

    explorerActions.refreshMcpCatalogue('s1');

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('mcp-server-exited: the server stopped');
    });
  });

  it('words the counts and the warnings', () => {
    const none = { tools: 0, resources: 0, resourceTemplates: 0, prompts: 0 };
    expect(refreshSummary('Files', none, [])).toBe('Files lists nothing');
    expect(refreshSummary('Files', { ...none, prompts: 1 }, [])).toBe('Fetched 1 prompt from Files');
    expect(
      refreshSummary('Files', { tools: 1, resources: 2, resourceTemplates: 3, prompts: 0 }, [
        'tools stopped at 50 pages.',
      ]),
    ).toBe('Fetched 1 tool, 2 resources and 3 resource templates from Files. tools stopped at 50 pages.');
  });
});

describe('New request from tool…', () => {
  it('asks for a refresh first when the server has no catalogue', () => {
    useProjectStore.setState({ mcpServers: { s1: mcpServerWire({ id: 's1', name: 'Files' }) } });
    explorerActions.newMcpRequestFromTool('s1');
    expect(useMcpToolPicker.getState().apiId).toBeUndefined();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Refresh the catalogue of Files first'));
  });

  it('picks a catalogued tool and makes a call of it', async () => {
    const addMcpRequest = vi.fn().mockResolvedValue('r9');
    useProjectStore.setState({
      mcpServers: { s1: mcpServerWire({ id: 's1', catalogue: CATALOGUE }) },
      mcpRequests: { r9: mcpRequestWire({ id: 'r9', name: 'list_dir' }) },
      addMcpRequest,
    });
    explorerActions.newMcpRequestFromTool('s1');
    expect(useMcpToolPicker.getState().apiId).toBe('s1');

    render(<McpToolPickerDialog />);
    expect(screen.getAllByTestId('mcp-tool-picker-item').map((item) => item.textContent)).toEqual([
      'read_fileReads a file',
      'List directory',
    ]);
    fireEvent.change(screen.getByTestId('mcp-tool-picker-filter'), { target: { value: 'dir' } });
    fireEvent.click(screen.getByText('List directory'));

    expect(addMcpRequest).toHaveBeenCalledWith('s1', undefined, 'list_dir', {
      method: 'tools/call',
      tool: 'list_dir',
      arguments: '',
    });
    await waitFor(() => {
      expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['mcp:r9']);
    });
    expect(useMcpToolPicker.getState().apiId).toBeUndefined();
  });

  it('filters by name, title or description', () => {
    const tool = { name: 'read_file', title: 'Read', description: 'Reads one file' };
    expect(['', 'READ_', 'one file', 'read'].map((filter) => toolMatches(tool, filter))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(toolMatches(tool, 'write')).toBe(false);
  });
});

describe('New MCP server…', () => {
  it('builds each transport from the form, and says what is missing', () => {
    const form = {
      name: 'Files',
      type: 'stdio',
      command: ' npx ',
      args: '-y\n\n @scope/server  \n/my dir',
      url: '',
    } as const;
    expect(transportOf(form)).toEqual({
      transport: { type: 'stdio', command: 'npx', args: ['-y', '@scope/server', '/my dir'], env: [] },
    });
    expect(transportOf({ ...form, command: '' })).toEqual({ problem: 'Enter the command that starts the server' });
    expect(transportOf({ ...form, type: 'sse', url: 'https://x.test/sse' })).toEqual({
      transport: { type: 'sse', url: 'https://x.test/sse', headers: [] },
    });
    expect(transportOf({ ...form, type: 'http' })).toEqual({ problem: 'Enter the server’s URL' });
  });

  it('creates a stdio server and opens its tab', async () => {
    const addMcpServer = vi.fn().mockResolvedValue('s9');
    useProjectStore.setState({ addMcpServer, mcpServers: { s9: mcpServerWire({ id: 's9', name: 'Files' }) } });
    useNewMcpServerDialog.getState().open('p1', 'MCP server 1');
    render(<NewMcpServerDialog />);

    const name = screen.getByTestId('new-mcp-server-name');
    expect(name).toHaveProperty('value', 'MCP server 1');
    fireEvent.change(name, { target: { value: 'Files' } });
    fireEvent.change(screen.getByTestId('new-mcp-server-command'), { target: { value: 'node' } });
    fireEvent.change(screen.getByTestId('new-mcp-server-args'), { target: { value: 'server.js' } });
    fireEvent.click(screen.getByTestId('new-mcp-server-create'));

    expect(addMcpServer).toHaveBeenCalledWith('p1', 'Files', {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: [],
    });
    await waitFor(() => {
      expect(useEditorsStore.getState().tabs.map((tab) => [tab.id, tab.kind])).toEqual([['mcp-api:s9', 'mcp-api']]);
    });
    expect(useNewMcpServerDialog.getState().projectId).toBeUndefined();
  });

  it('asks an HTTP server for its URL, and shows why a create failed', async () => {
    const addMcpServer = vi.fn().mockRejectedValue(new Error('A server named Files exists'));
    useProjectStore.setState({ addMcpServer });
    useNewMcpServerDialog.getState().open('p1', 'Files');
    render(<NewMcpServerDialog />);

    fireEvent.click(screen.getByTestId('new-mcp-server-transport-http'));
    fireEvent.click(screen.getByTestId('new-mcp-server-create'));
    expect(screen.getByRole('alert').textContent).toBe('Enter the server’s URL');
    expect(addMcpServer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('new-mcp-server-url'), { target: { value: 'https://mcp.test/mcp' } });
    fireEvent.click(screen.getByTestId('new-mcp-server-create'));
    expect(addMcpServer).toHaveBeenCalledWith('p1', 'Files', {
      type: 'http',
      url: 'https://mcp.test/mcp',
      headers: [],
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('A server named Files exists');
    });
    expect(useNewMcpServerDialog.getState().projectId).toBe('p1');
  });
});

describe('an MCP History entry', () => {
  function mcpEntry(mcp: Partial<NonNullable<HistoryEntryWire['mcp']>> = {}): HistoryEntryWire {
    return {
      id: 'h-mcp',
      kind: 'mcp',
      at: '2026-10-14T10:00:00.000Z',
      projectId: 'p1',
      requestId: 'r1',
      requestName: 'Read',
      interfaceName: '',
      operationName: '',
      endpoint: 'node server.js',
      soapVersion: 'none',
      durationMs: 120,
      ok: true,
      request: { envelopeXml: '', headers: [] },
      sizeBytes: 60,
      mcp: {
        transport: { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/ws/demo', env: {} },
        method: 'tools/call',
        startedAt: '2026-10-14T10:00:00.000Z',
        messages: [
          {
            direction: 'sent',
            at: '2026-10-14T10:00:00.010Z',
            size: 60,
            kind: 'request',
            id: 2,
            method: 'tools/call',
            text: '{"jsonrpc":"2.0","id":2,"method":"tools/call"}',
            warnings: [],
          },
        ],
        droppedMessages: 0,
        result: { content: [{ type: 'text', text: 'hello' }] },
        warnings: [],
        ...mcp,
      },
    };
  }

  it('shows how the server answered, the result and the messages', () => {
    render(<McpHistoryBody entry={mcpEntry()} />);
    expect(screen.getByTestId('mcp-history-outcome').textContent).toBe('OK');
    expect(screen.getByTestId('mcp-history-result').textContent).toContain('hello');
    expect(screen.getByTestId('mcp-block-text')).not.toBeNull();
    expect(screen.getByTestId('mcp-history-messages').textContent).toContain('tools/call');
  });

  it('words an error, a tool error and a failure', () => {
    const of = (patch: Partial<NonNullable<HistoryEntryWire['mcp']>>): string =>
      mcpOutcome(mcpEntry(patch).mcp as NonNullable<HistoryEntryWire['mcp']>);
    expect(of({ result: undefined, error: { code: -32602, message: 'Invalid params' } })).toBe(
      'Error -32602 Invalid params',
    );
    expect(of({ result: { content: [], isError: true } })).toBe('Tool error (isError)');
    expect(of({ failure: { code: 'mcp-server-exited', message: 'The server exited' } })).toBe('The server exited');
  });
});
