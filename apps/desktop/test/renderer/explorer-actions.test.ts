import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { explorerActions } from '../../src/renderer/features/explorer/explorer-actions.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { registerExplorerTree } from '../../src/renderer/features/explorer/explorer-api.js';
import { restApiWire, restFolderWire, restRequestWire, wsApiWire, wsRequestWire } from '../helpers/wire-defaults.js';

/** Sets `preferences.ui.confirmOnDelete` on the mirror. */
function confirmOnDelete(value: boolean): void {
  usePreferencesStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES_WIRE,
      ui: { ...DEFAULT_PREFERENCES_WIRE.ui, confirmOnDelete: value },
    },
    loaded: true,
  });
}

describe('explorerActions deletion', () => {
  beforeEach(() => {
    installWirebenchApi();
    useUiStore.setState({ confirmDeleteRequestId: undefined, confirmRemoveInterfaceId: undefined });
  });

  it('asks first when confirmOnDelete is on', () => {
    confirmOnDelete(true);
    const removeRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeRequest });

    explorerActions.deleteRequest('req-1');

    expect(useUiStore.getState().confirmDeleteRequestId).toBe('req-1');
    expect(removeRequest).not.toHaveBeenCalled();
  });

  it('deletes straight away when confirmOnDelete is off', () => {
    confirmOnDelete(false);
    const removeRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeRequest });

    explorerActions.deleteRequest('req-1');

    expect(removeRequest).toHaveBeenCalledWith('req-1');
    expect(useUiStore.getState().confirmDeleteRequestId).toBeUndefined();
  });

  it('applies the same preference to removing an interface', () => {
    confirmOnDelete(false);
    const removeInterface = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeInterface });

    explorerActions.removeInterface('iface-1');

    expect(removeInterface).toHaveBeenCalledWith('iface-1');
    expect(useUiStore.getState().confirmRemoveInterfaceId).toBeUndefined();
  });

  it('is a no-op without an id', () => {
    confirmOnDelete(false);
    const removeRequest = vi.fn();
    useProjectStore.setState({ removeRequest });

    explorerActions.deleteRequest(undefined);
    explorerActions.removeInterface(undefined);

    expect(removeRequest).not.toHaveBeenCalled();
  });
});

/**
 * The REST creators and destroyers. Each case pins the store call the action makes, because that
 * call is the whole action: the mutation payload is what reaches disk, and the tab it opens
 * afterwards is what the user sees.
 */
describe('explorerActions for REST nodes', () => {
  beforeEach(() => {
    installWirebenchApi();
    useEditorsStore.getState().reset();
    useUiStore.setState({ confirmDeleteNode: undefined });
    useProjectStore.setState({ apis: {}, folders: {}, restRequests: {} });
  });

  it('names a new API after the ones already there, and opens its tab', async () => {
    const addApi = vi.fn().mockResolvedValue('api-new');
    useProjectStore.setState({
      addApi,
      apis: { 'api-1': restApiWire({ name: 'API 1' }) },
    });

    explorerActions.newApi('p1');
    await vi.waitFor(() => {
      expect(addApi).toHaveBeenCalledWith('p1', 'API 2');
    });
    // The tab opens once the mirror holds the new API — the reply is what carries its name.
    useProjectStore.setState({
      apis: { 'api-1': restApiWire({ name: 'API 1' }), 'api-new': restApiWire({ id: 'api-new', name: 'API 2' }) },
    });
    explorerActions.openApi('api-new');
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['api:api-new']);
  });

  it('creates a folder at the API root and puts the row into rename mode', async () => {
    const addFolder = vi.fn().mockResolvedValue('folder-new');
    useProjectStore.setState({ addFolder, folders: { 'folder-1': restFolderWire({ name: 'Folder 1' }) } });
    const edit = vi.fn();
    registerExplorerTree({ get: () => ({ edit }) } as unknown as Parameters<typeof registerExplorerTree>[0]);

    explorerActions.newFolder('api-1');
    await vi.waitFor(() => {
      expect(edit).toHaveBeenCalled();
    });
    expect(addFolder).toHaveBeenCalledWith('api-1', undefined, 'Folder 2');
    registerExplorerTree(null);
  });

  it('creates a folder inside the folder the caller named', () => {
    const addFolder = vi.fn().mockResolvedValue('folder-new');
    useProjectStore.setState({ addFolder });

    explorerActions.newFolder('api-1', 'folder-1');

    expect(addFolder).toHaveBeenCalledWith('api-1', 'folder-1', 'Folder 1');
  });

  it('creates a REST request and opens its editor', async () => {
    const addRestRequest = vi.fn().mockResolvedValue('rest-new');
    useProjectStore.setState({ addRestRequest, restRequests: { 'rest-new': restRequestWire({ id: 'rest-new' }) } });

    explorerActions.newRestRequest('api-1', 'folder-1');
    await vi.waitFor(() => {
      expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['rest:rest-new']);
    });
    expect(addRestRequest).toHaveBeenCalledWith('api-1', 'folder-1');
  });

  it('duplicates a request and opens the copy', async () => {
    const cloneRestRequest = vi.fn().mockResolvedValue('rest-copy');
    useProjectStore.setState({
      cloneRestRequest,
      restRequests: { 'rest-copy': restRequestWire({ id: 'rest-copy', name: 'Get pet (copy)' }) },
    });

    explorerActions.duplicateRestRequest('rest-1');
    await vi.waitFor(() => {
      expect(useEditorsStore.getState().tabs[0]?.title).toBe('Get pet (copy)');
    });
    expect(cloneRestRequest).toHaveBeenCalledWith('rest-1');
  });

  it('always confirms deleting an API that holds requests, even with the preference off', () => {
    confirmOnDelete(false);
    const removeApi = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      removeApi,
      apis: { 'api-1': restApiWire() },
      restRequests: { 'rest-1': restRequestWire(), 'rest-2': restRequestWire({ id: 'rest-2' }) },
    });

    explorerActions.removeApi('api-1');

    expect(removeApi).not.toHaveBeenCalled();
    expect(useUiStore.getState().confirmDeleteNode).toEqual({
      kind: 'api',
      id: 'api-1',
      name: 'Petstore',
      requestCount: 2,
    });
  });

  it('deletes an empty API straight away when the preference is off', () => {
    confirmOnDelete(false);
    const removeApi = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeApi, apis: { 'api-1': restApiWire() } });

    explorerActions.removeApi('api-1');

    expect(removeApi).toHaveBeenCalledWith('api-1');
    expect(useUiStore.getState().confirmDeleteNode).toBeUndefined();
  });

  it('counts the requests in a folder and in the folders under it', () => {
    confirmOnDelete(false);
    useProjectStore.setState({
      removeFolder: vi.fn().mockResolvedValue(undefined),
      folders: {
        'folder-1': restFolderWire(),
        'folder-2': restFolderWire({ id: 'folder-2', parentId: 'folder-1' }),
        'folder-3': restFolderWire({ id: 'folder-3', parentId: 'folder-2' }),
        elsewhere: restFolderWire({ id: 'elsewhere' }),
      },
      restRequests: {
        a: restRequestWire({ id: 'a', folderId: 'folder-1' }),
        b: restRequestWire({ id: 'b', folderId: 'folder-3' }),
        c: restRequestWire({ id: 'c', folderId: 'elsewhere' }),
      },
    });

    explorerActions.removeFolder('folder-1');

    expect(useUiStore.getState().confirmDeleteNode?.requestCount).toBe(2);
  });

  it('deletes a REST request straight away with the preference off, and asks with it on', () => {
    const removeRestRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeRestRequest, restRequests: { 'rest-1': restRequestWire() } });

    confirmOnDelete(false);
    explorerActions.deleteRestRequest('rest-1');
    expect(removeRestRequest).toHaveBeenCalledWith('rest-1');

    confirmOnDelete(true);
    explorerActions.deleteRestRequest('rest-1');
    expect(useUiStore.getState().confirmDeleteNode).toMatchObject({ kind: 'rest-request', id: 'rest-1' });
  });

  it('does nothing for an entity the mirror no longer holds', () => {
    const removeApi = vi.fn();
    const removeFolder = vi.fn();
    const removeRestRequest = vi.fn();
    useProjectStore.setState({ removeApi, removeFolder, removeRestRequest });

    explorerActions.removeApi('gone');
    explorerActions.removeFolder('gone');
    explorerActions.deleteRestRequest('gone');

    expect(removeApi).not.toHaveBeenCalled();
    expect(removeFolder).not.toHaveBeenCalled();
    expect(removeRestRequest).not.toHaveBeenCalled();
    expect(useUiStore.getState().confirmDeleteNode).toBeUndefined();
  });
});

describe('explorerActions for WebSocket nodes', () => {
  beforeEach(() => {
    installWirebenchApi();
    useEditorsStore.getState().reset();
    useUiStore.setState({ confirmDeleteNode: undefined });
    useProjectStore.setState({ wsApis: {}, folders: {}, wsRequests: {} });
  });

  it('names a new WebSocket API after the ones already there, and opens its tab', async () => {
    const addWsApi = vi.fn().mockResolvedValue('ws-api-new');
    useProjectStore.setState({
      addWsApi,
      wsApis: { 'ws-api-1': wsApiWire({ name: 'WebSocket API 1' }) },
    });

    explorerActions.newWsApi('p1');
    await vi.waitFor(() => {
      expect(addWsApi).toHaveBeenCalledWith('p1', 'WebSocket API 2');
    });
    useProjectStore.setState({
      wsApis: {
        'ws-api-1': wsApiWire({ name: 'WebSocket API 1' }),
        'ws-api-new': wsApiWire({ id: 'ws-api-new', name: 'WebSocket API 2' }),
      },
    });
    explorerActions.openWsApi('ws-api-new');
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['ws-api:ws-api-new']);
  });

  it('creates a WebSocket request and opens its editor', async () => {
    const addWsRequest = vi.fn().mockResolvedValue('ws-new');
    useProjectStore.setState({ addWsRequest, wsRequests: { 'ws-new': wsRequestWire({ id: 'ws-new' }) } });

    explorerActions.newWsRequest('ws-api-1', 'folder-1');
    await vi.waitFor(() => {
      expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['ws:ws-new']);
    });
    expect(addWsRequest).toHaveBeenCalledWith('ws-api-1', 'folder-1');
  });

  it('duplicates a WebSocket request and opens the copy', async () => {
    const cloneWsRequest = vi.fn().mockResolvedValue('ws-copy');
    useProjectStore.setState({
      cloneWsRequest,
      wsRequests: { 'ws-copy': wsRequestWire({ id: 'ws-copy', name: 'Lobby (copy)' }) },
    });

    explorerActions.duplicateWsRequest('ws-1');
    await vi.waitFor(() => {
      expect(useEditorsStore.getState().tabs[0]?.title).toBe('Lobby (copy)');
    });
    expect(cloneWsRequest).toHaveBeenCalledWith('ws-1');
  });

  it('always confirms deleting a WebSocket API that holds requests, even with the preference off', () => {
    confirmOnDelete(false);
    const removeWsApi = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      removeWsApi,
      wsApis: { 'ws-api-1': wsApiWire() },
      wsRequests: { 'ws-1': wsRequestWire(), 'ws-2': wsRequestWire({ id: 'ws-2' }) },
    });

    explorerActions.removeWsApi('ws-api-1');

    expect(removeWsApi).not.toHaveBeenCalled();
    expect(useUiStore.getState().confirmDeleteNode).toEqual({
      kind: 'ws-api',
      id: 'ws-api-1',
      name: 'Chat',
      requestCount: 2,
    });
  });

  it('deletes an empty WebSocket API straight away when the preference is off', () => {
    confirmOnDelete(false);
    const removeWsApi = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeWsApi, wsApis: { 'ws-api-1': wsApiWire() } });

    explorerActions.removeWsApi('ws-api-1');

    expect(removeWsApi).toHaveBeenCalledWith('ws-api-1');
    expect(useUiStore.getState().confirmDeleteNode).toBeUndefined();
  });

  it('deletes a WebSocket request straight away with the preference off, and asks with it on', () => {
    const removeWsRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeWsRequest, wsRequests: { 'ws-1': wsRequestWire() } });

    confirmOnDelete(false);
    explorerActions.deleteWsRequest('ws-1');
    expect(removeWsRequest).toHaveBeenCalledWith('ws-1');

    confirmOnDelete(true);
    explorerActions.deleteWsRequest('ws-1');
    expect(useUiStore.getState().confirmDeleteNode).toMatchObject({ kind: 'ws-request', id: 'ws-1' });
  });

  it('does nothing for an entity the mirror no longer holds', () => {
    const removeWsApi = vi.fn();
    const removeWsRequest = vi.fn();
    useProjectStore.setState({ removeWsApi, removeWsRequest });

    explorerActions.removeWsApi('gone');
    explorerActions.deleteWsRequest('gone');

    expect(removeWsApi).not.toHaveBeenCalled();
    expect(removeWsRequest).not.toHaveBeenCalled();
    expect(useUiStore.getState().confirmDeleteNode).toBeUndefined();
  });
});
