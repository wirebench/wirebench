/**
 * An MCP server's tab (#79): the connection form of each transport, the env and header tables, the
 * settings, the catalogue with its refresh, and a request made from a tool row. Every edit is one
 * `update-mcp-server` patch carrying the whole transport (or the whole settings).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { McpApiTab } from '../../src/renderer/features/mcp-api/mcp-api-tab.js';
import { switchTransport } from '../../src/renderer/features/mcp-api/connection-section.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { mcpRequestWire, mcpServerWire } from '../helpers/wire-defaults.js';
import type { McpServerWire, McpTransportWire } from '@wirebench/wire/kinds/mcp/wire';
import { openSettingsTab, resetSettingsTabs } from '../helpers/settings-page-tabs.js';

const updateMcpServer = vi.fn();
const refreshMcpCatalogue = vi.fn();
const addMcpRequest = vi.fn();

const HTTP: Extract<McpTransportWire, { type: 'http' }> = { type: 'http', url: 'https://mcp.test/mcp', headers: [] };

function mount(server: McpServerWire = mcpServerWire()): void {
  useProjectStore.setState({
    mcpServers: { [server.id]: server },
    mcpRequests: { r1: mcpRequestWire({ id: 'r1', name: 'read_file' }) },
    projectOf: { [server.id]: 'p1' },
    updateMcpServer,
    refreshMcpCatalogue,
    addMcpRequest,
  });
  render(
    <TooltipPrimitive.Provider>
      <McpApiTab apiId={server.id} />
    </TooltipPrimitive.Provider>,
  );
}

function commit(testId: string, value: string): void {
  const field = screen.getByTestId(testId);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

beforeEach(() => {
  resetSettingsTabs();
  showToast.mockClear();
  updateMcpServer.mockReset().mockResolvedValue(undefined);
  refreshMcpCatalogue.mockReset();
  addMcpRequest.mockReset().mockResolvedValue('r1');
  installWirebenchApi();
  useEditorsStore.setState({ tabs: [], activeId: undefined });
});

afterEach(() => {
  cleanup();
});

describe('McpApiTab — the stdio form', () => {
  it('shows the command, each argument and the folder', () => {
    mount(
      mcpServerWire({
        transport: { type: 'stdio', command: 'node', args: ['server.js', '--root', 'a b'], cwd: 'tools', env: [] },
      }),
    );
    openSettingsTab('Connection');

    expect(screen.getByTestId<HTMLSelectElement>('mcp-api-transport').value).toBe('stdio');
    expect(screen.getByTestId<HTMLInputElement>('mcp-api-command').value).toBe('node');
    expect(screen.getByTestId<HTMLInputElement>('mcp-api-arg-2').value).toBe('a b');
    expect(screen.getByTestId<HTMLInputElement>('mcp-api-cwd').value).toBe('tools');
    expect(screen.queryByTestId('mcp-api-url')).toBeNull();
  });

  it('patches the whole transport for a command, an argument added, edited or removed, and the folder', () => {
    mount();
    openSettingsTab('Connection');
    const base = { type: 'stdio', command: 'node', args: ['server.js'], env: [] };

    commit('mcp-api-command', 'npx');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', { transport: { ...base, command: 'npx' } });

    commit('mcp-api-arg-new', '--verbose');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', {
      transport: { ...base, args: ['server.js', '--verbose'] },
    });

    commit('mcp-api-arg-0', 'main.js');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', { transport: { ...base, args: ['main.js'] } });

    fireEvent.click(screen.getByTestId('mcp-api-arg-remove-0'));
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', { transport: { ...base, args: [] } });

    commit('mcp-api-cwd', 'tools');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', { transport: { ...base, cwd: 'tools' } });
  });

  it('writes no folder when the field is emptied', () => {
    mount(mcpServerWire({ transport: { type: 'stdio', command: 'node', args: [], cwd: 'tools', env: [] } }));
    openSettingsTab('Connection');

    commit('mcp-api-cwd', '');

    expect(updateMcpServer).toHaveBeenCalledWith('mcp-api-1', {
      transport: { type: 'stdio', command: 'node', args: [], env: [] },
    });
  });

  it('edits the environment through the shared table', () => {
    mount();
    openSettingsTab('Connection');

    fireEvent.change(screen.getByTestId('mcp-api-env-new-name'), { target: { value: 'API_TOKEN' } });

    expect(updateMcpServer).toHaveBeenCalledWith('mcp-api-1', {
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: [{ enabled: true, name: 'API_TOKEN', value: '' }],
      },
    });
  });
});

describe('McpApiTab — the HTTP and SSE forms', () => {
  it('shows the URL, the headers and the credentials of a Streamable HTTP server', () => {
    mount(mcpServerWire({ transport: { ...HTTP, headers: [{ enabled: true, name: 'X-Team', value: 'qa' }] } }));
    openSettingsTab('Connection');

    expect(screen.getByTestId<HTMLSelectElement>('mcp-api-transport').value).toBe('http');
    expect(screen.getByTestId<HTMLInputElement>('mcp-api-url').value).toBe('https://mcp.test/mcp');
    expect(screen.getByLabelText('Server authentication type')).toBeTruthy();
    expect(screen.queryByTestId('mcp-api-command')).toBeNull();
    expect(screen.queryByTestId('mcp-api-env-new-name')).toBeNull();
  });

  it('patches the URL, a header and the auth', () => {
    mount(mcpServerWire({ transport: HTTP }));
    openSettingsTab('Connection');

    commit('mcp-api-url', 'https://other.test/mcp');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', {
      transport: { ...HTTP, url: 'https://other.test/mcp' },
    });

    fireEvent.change(screen.getByTestId('mcp-api-headers-new-name'), { target: { value: 'X-Team' } });
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', {
      transport: { ...HTTP, headers: [{ enabled: true, name: 'X-Team', value: '' }] },
    });

    fireEvent.change(screen.getByLabelText('Server authentication type'), { target: { value: 'basic' } });
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', { transport: { ...HTTP, auth: { type: 'basic' } } });
  });

  it('says an SSE server’s URL is the event-stream endpoint', () => {
    mount(mcpServerWire({ transport: { ...HTTP, type: 'sse' as const, url: 'https://mcp.test/sse' } }));
    openSettingsTab('Connection');

    expect(screen.getByTestId<HTMLSelectElement>('mcp-api-transport').value).toBe('sse');
    // A compact row carries its hint as the label's title.
    expect(screen.getByText('URL').getAttribute('title')).toBe('The event-stream endpoint.');
  });

  it('switches transport, keeping the HTTP fields between HTTP and SSE only', () => {
    mount();
    openSettingsTab('Connection');

    fireEvent.change(screen.getByTestId('mcp-api-transport'), { target: { value: 'http' } });
    expect(updateMcpServer).toHaveBeenCalledWith('mcp-api-1', { transport: { type: 'http', url: '', headers: [] } });

    const http = { ...HTTP, auth: { type: 'basic' as const } };
    expect(switchTransport(http, 'sse')).toEqual({ ...http, type: 'sse' });
    expect(switchTransport(http, 'stdio')).toEqual({ type: 'stdio', command: '', args: [], env: [] });
    expect(switchTransport(http, 'http')).toBe(http);
  });
});

describe('McpApiTab — name and settings', () => {
  it('patches the name, the timeout and the protocol version, and clears them back to absent', () => {
    mount(mcpServerWire({ settings: { timeoutMs: 5000 } }));

    commit('mcp-api-name', 'Disk');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', { name: 'Disk' });
    openSettingsTab('Settings');

    commit('mcp-api-protocol-version', '2025-06-18');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', {
      settings: { timeoutMs: 5000, protocolVersion: '2025-06-18' },
    });

    commit('mcp-api-timeout', '');
    expect(updateMcpServer).toHaveBeenLastCalledWith('mcp-api-1', { settings: {} });
  });

  it('says so, rather than throwing, for a server that no longer exists', () => {
    useProjectStore.setState({ mcpServers: {} });
    render(<McpApiTab apiId="gone" />);

    expect(screen.getByText('This MCP server is no longer in the project.')).toBeTruthy();
  });
});

describe('McpApiTab — the catalogue', () => {
  const catalogued = mcpServerWire({
    catalogueInfo: {
      fetchedAt: '2026-10-14T09:30:00.000Z',
      serverInfo: { name: 'files-server', version: '1.4.0' },
      protocolVersion: '2025-06-18',
    },
    catalogue: {
      tools: [
        { name: 'read_file', description: 'Reads a file', inputSchema: { type: 'object' } },
        { name: 'list_dir', title: 'List directory', inputSchema: { type: 'object' } },
      ],
      resources: [{ uri: 'file:///readme.md', name: 'readme', description: 'The readme' }],
      resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'file' }],
      prompts: [{ name: 'summarise', description: 'Summarise a file' }],
    },
  });

  it('lists each kind with its descriptions, and where it came from', () => {
    mount(catalogued);
    openSettingsTab('Catalogue');

    expect(screen.getAllByTestId('mcp-api-tools-row')).toHaveLength(2);
    expect(screen.getByText('Reads a file')).toBeTruthy();
    expect(screen.getByText('List directory')).toBeTruthy();
    expect(screen.getByText('The readme')).toBeTruthy();
    expect(screen.getByText('file:///{path}')).toBeTruthy();
    expect(screen.getByText('Summarise a file')).toBeTruthy();
    const fetched = screen.getByTestId('mcp-api-fetched').textContent ?? '';
    expect(fetched).toMatch(/^Fetched .+ from files-server 1\.4\.0$/);
  });

  it('says it was never fetched', () => {
    mount();
    openSettingsTab('Catalogue');

    expect(screen.getByTestId('mcp-api-fetched').textContent).toBe('Not fetched yet.');
    expect(screen.queryByTestId('mcp-api-tools')).toBeNull();
  });

  it('refreshes, busy until it is done, and says what it found', async () => {
    let finish: (value: unknown) => void = () => undefined;
    refreshMcpCatalogue.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    openSettingsTab('Catalogue');

    fireEvent.click(screen.getByTestId('mcp-api-refresh'));
    expect(refreshMcpCatalogue).toHaveBeenCalledWith('mcp-api-1');
    const button = screen.getByTestId<HTMLButtonElement>('mcp-api-refresh');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Refreshing…');

    finish({
      projectId: 'p1',
      info: { fetchedAt: 'now', serverInfo: { name: 'files', version: '1' }, protocolVersion: '2025-06-18' },
      counts: { tools: 2, resources: 0, resourceTemplates: 0, prompts: 0 },
      warnings: [],
    });
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('mcp-api-refresh').disabled).toBe(false);
    });
    expect(showToast).toHaveBeenCalledWith('Fetched 2 tools from Files');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows why a refresh failed, and clears it on the next try', async () => {
    refreshMcpCatalogue.mockRejectedValueOnce(new Error('mcp-server-exited: the server stopped'));
    mount();
    openSettingsTab('Catalogue');

    fireEvent.click(screen.getByTestId('mcp-api-refresh'));

    expect((await screen.findByRole('alert')).textContent).toBe('mcp-server-exited: the server stopped');
    expect(screen.getByTestId<HTMLButtonElement>('mcp-api-refresh').disabled).toBe(false);

    refreshMcpCatalogue.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(screen.getByTestId('mcp-api-refresh'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('makes a tools/call request from a tool row and opens it', async () => {
    mount(catalogued);
    openSettingsTab('Catalogue');

    fireEvent.click(screen.getByRole('button', { name: 'New request for read_file' }));

    expect(addMcpRequest).toHaveBeenCalledWith('mcp-api-1', undefined, 'read_file', {
      method: 'tools/call',
      tool: 'read_file',
      arguments: '',
    });
    await waitFor(() => {
      expect(useEditorsStore.getState().activeId).toBe('mcp:r1');
    });
  });
});
