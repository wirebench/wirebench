import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { openSettingsTab, resetSettingsTabs } from '../helpers/settings-page-tabs.js';
import { restApiWire, restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const { FolderTab, descendantFolders } = await import('../../src/renderer/features/folder/folder-tab.js');
const { pathParts } = await import('../../src/renderer/features/explorer/page-path.js');
const { useProjectStore } = await import('../../src/renderer/state/project.js');
const { useEditorsStore } = await import('../../src/renderer/state/editors.js');

const updateFolder = vi.fn();
const updateRequestScripts = vi.fn();

const FOLDERS = {
  orders: restFolderWire({ id: 'orders', name: 'Orders', description: 'All about **orders**.' }),
  refunds: restFolderWire({ id: 'refunds', name: 'Refunds', parentId: 'orders' }),
  deep: restFolderWire({ id: 'deep', name: 'Deep', parentId: 'refunds' }),
  other: restFolderWire({ id: 'other', name: 'Other' }),
};

function seed(extra: Record<string, unknown> = {}): void {
  useProjectStore.setState({
    projects: { p1: { id: 'p1', name: 'caas' } },
    projectOf: { 'api-1': 'p1' },
    apis: { 'api-1': restApiWire({ name: 'Cards API' }) },
    grpcApis: {},
    wsApis: {},
    mcpServers: {},
    folders: FOLDERS,
    restRequests: {
      r1: restRequestWire({ id: 'r1', folderId: 'orders' }),
      r2: restRequestWire({ id: 'r2', folderId: 'deep' }),
      r3: restRequestWire({ id: 'r3', folderId: 'other' }),
    },
    updateFolder,
    updateRequestScripts,
    ...extra,
  } as never);
}

beforeEach(() => {
  updateFolder.mockReset().mockResolvedValue(undefined);
  updateRequestScripts.mockReset().mockResolvedValue(undefined);
  installWirebenchApi({
    script: { diagnostics: vi.fn().mockResolvedValue({ ok: true, value: { diagnostics: [] } }) },
  });
  resetSettingsTabs();
  useEditorsStore.getState().reset();
  seed();
});

afterEach(() => {
  cleanup();
});

describe('descendantFolders', () => {
  it('finds the folders inside one, at any depth', () => {
    expect([...descendantFolders('orders', FOLDERS)].sort()).toEqual(['deep', 'refunds']);
    expect(descendantFolders('deep', FOLDERS).size).toBe(0);
  });
});

describe('FolderTab', () => {
  it('opens on General: name, rendered description and what it holds', () => {
    render(<FolderTab folderId="orders" />);
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId<HTMLInputElement>('folder-name').value).toBe('Orders');
    expect(screen.getByTestId('folder-overview').querySelector('strong')?.textContent).toBe('orders');
    expect(screen.getByTestId('folder-summary-requests').textContent).toBe('2 requests');
    expect(screen.getByTestId('folder-summary-folders').textContent).toBe('2 folders');
  });

  it('renames the folder and edits its description', () => {
    render(<FolderTab folderId="orders" />);
    const name = screen.getByTestId('folder-name');
    fireEvent.change(name, { target: { value: 'Purchase orders' } });
    fireEvent.blur(name);
    expect(updateFolder).toHaveBeenCalledWith('orders', { name: 'Purchase orders' });

    fireEvent.click(screen.getByTestId('folder-overview-edit'));
    fireEvent.change(screen.getByTestId('folder-overview-editor'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('folder-overview-save'));
    expect(updateFolder).toHaveBeenLastCalledWith('orders', { description: null });
  });

  it('sets the credentials every request inside inherits', () => {
    render(<FolderTab folderId="orders" />);
    openSettingsTab('Authentication');
    fireEvent.change(screen.getByLabelText('Folder authentication type'), { target: { value: 'basic' } });
    expect(updateFolder).toHaveBeenCalledWith('orders', { auth: { type: 'basic' } });
  });

  it('edits the folder’s scripts', async () => {
    seed({
      folders: {
        ...FOLDERS,
        orders: { ...FOLDERS.orders, scripts: { api: 'postman', enabled: false, secrets: [], pre: 'x' } },
      },
    });
    render(<FolderTab folderId="orders" />);
    openSettingsTab('Scripts');
    fireEvent.click(await screen.findByTestId('scripts-switch-on'));
    expect(updateRequestScripts).toHaveBeenCalledWith('orders', { enabled: true });
  });

  it('has no Scripts tab for a WebSocket folder', () => {
    seed({
      wsApis: { 'ws-1': { id: 'ws-1', name: 'Chat' } },
      folders: { ...FOLDERS, room: restFolderWire({ id: 'room', apiId: 'ws-1', name: 'Rooms' }) },
    });
    render(<FolderTab folderId="room" />);
    expect(screen.queryByRole('tab', { name: 'Scripts' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Authentication' })).toBeTruthy();
  });

  it('shows where the folder sits, and each outer part opens its page', () => {
    render(<FolderTab folderId="deep" />);
    const path = screen.getByTestId('page-path');
    expect(path.textContent).toBe('caasCards APIOrdersRefundsDeep');
    fireEvent.click(screen.getByRole('button', { name: 'Refunds' }));
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toContain('folder:refunds');
    fireEvent.click(screen.getByRole('button', { name: 'Cards API' }));
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toContain('api:api-1');
    expect(screen.queryByRole('button', { name: 'Deep' })).toBeNull();
  });

  it('says so for a folder that is gone', () => {
    render(<FolderTab folderId="gone" />);
    expect(screen.getByText('This folder is no longer in the project.')).toBeTruthy();
  });
});

describe('pathParts', () => {
  it('names the project and the API for an API page, the API being the current part', () => {
    const state = useProjectStore.getState();
    const parts = pathParts({ apiId: 'api-1' }, state);
    expect(parts.map((part) => part.label)).toEqual(['caas', 'Cards API']);
    expect(parts[0]?.open).toBeTypeOf('function');
    expect(parts[1]?.open).toBeUndefined();
  });
});
