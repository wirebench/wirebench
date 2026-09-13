import { showToast } from '../../components/toast.js';
import { openRequestTab, recreateRequest } from '../request-editor/request-actions.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { startRenamingNode, startRenamingRequest } from './explorer-api.js';
import { openRestRequestTab } from '../rest-editor/rest-actions.js';
import { openApiTab } from '../rest-api/api-actions.js';
import { useWsiStore } from '../../state/wsi.js';
import {
  exportDefinition,
  generateDocumentation,
  openInterfaceTab,
  updateDefinition,
} from '../interface-editor/interface-actions.js';

/**
 * The logic behind every explorer action (right-click menu items and their `explorer.*` command
 * mirrors). Kept here, shared by both, so the palette and the context menu can never drift.
 */

/** Whether deleting should prompt first — `preferences.ui.confirmOnDelete`. */
function confirmsDeletes(): boolean {
  return usePreferencesStore.getState().preferences.ui.confirmOnDelete;
}

export const explorerActions = {
  importAnother(): void {
    useUiStore.getState().openImportDialog();
  },

  removeInterface(interfaceId: string | undefined): void {
    if (interfaceId === undefined) {
      return;
    }
    if (!confirmsDeletes()) {
      void useProjectStore.getState().removeInterface(interfaceId);
      return;
    }
    useUiStore.getState().requestRemoveInterface(interfaceId);
  },

  /** Opens the Interface editor ("Show Interface Viewer") for the selected interface. */
  showInterface(interfaceId: string | undefined): void {
    if (interfaceId !== undefined) {
      openInterfaceTab(interfaceId);
    }
  },

  /** Opens the Update Definition dialog on the selected interface's viewer. */
  updateDefinition(interfaceId: string | undefined): void {
    if (interfaceId !== undefined) {
      updateDefinition(interfaceId);
    }
  },

  /** Exports the selected interface's definition bundle to a folder the user picks. */
  exportDefinition(interfaceId: string | undefined): void {
    if (interfaceId !== undefined) {
      void exportDefinition(interfaceId).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Export definition failed');
      });
    }
  },

  /** Opens the Generate Documentation dialog on the selected interface's viewer. */
  generateDocs(interfaceId: string | undefined): void {
    if (interfaceId !== undefined) {
      generateDocumentation(interfaceId);
    }
  },

  copyDefinitionUrl(interfaceId: string | undefined): void {
    if (interfaceId === undefined) {
      return;
    }
    const summary = useProjectStore.getState().interfaces[interfaceId];
    if (summary !== undefined) {
      void navigator.clipboard.writeText(summary.definitionUrl);
    }
  },

  newRequest(
    interfaceId: string | undefined,
    bindingName: string | undefined,
    operationName: string | undefined,
  ): void {
    if (interfaceId === undefined || bindingName === undefined || operationName === undefined) {
      return;
    }
    void useProjectStore
      .getState()
      .addRequest(interfaceId, bindingName, operationName)
      .then((requestId) => {
        openRequestTab(requestId);
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'New request failed');
      });
  },

  copySoapAction(soapAction: string | undefined): void {
    if (soapAction !== undefined) {
      void navigator.clipboard.writeText(soapAction);
    }
  },

  openRequest(requestId: string | undefined): void {
    if (requestId !== undefined) {
      openRequestTab(requestId);
    }
  },

  cloneRequest(requestId: string | undefined): void {
    if (requestId === undefined) {
      return;
    }
    void useProjectStore
      .getState()
      .cloneRequest(requestId)
      .then(openRequestTab)
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Clone request failed');
      });
  },

  recreateRequest(requestId: string | undefined): void {
    if (requestId !== undefined) {
      void recreateRequest(requestId, 'keep-values');
    }
  },

  renameRequest(requestId: string | undefined): void {
    if (requestId !== undefined) {
      startRenamingRequest(requestId);
    }
  },

  deleteRequest(requestId: string | undefined): void {
    if (requestId === undefined) {
      return;
    }
    if (!confirmsDeletes()) {
      void useProjectStore.getState().removeRequest(requestId);
      return;
    }
    useUiStore.getState().requestDeleteRequest(requestId);
  },

  /** Runs the WS-I description catalogue over one interface and reveals the console tab. */
  checkWsiWsdl(interfaceId: string | undefined): void {
    if (interfaceId !== undefined) {
      void useWsiStore.getState().checkWsdl(interfaceId);
    }
  },

  /** Creates an API in one project and opens its tab, so the user lands on its base URL field. */
  newApi(projectId: string | undefined): void {
    if (projectId === undefined) {
      return;
    }
    void useProjectStore
      .getState()
      .addApi(
        projectId,
        nextName(
          'API',
          Object.values(useProjectStore.getState().apis).map((api) => api.name),
        ),
      )
      .then((apiId) => {
        openApiTab(apiId);
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'New API failed');
      });
  },

  /**
   * Creates a folder at an API's root, or inside another folder, and puts the row straight into
   * rename mode: a folder has nothing to configure, so naming it *is* the rest of the gesture.
   */
  newFolder(apiId: string | undefined, parentId?: string): void {
    if (apiId === undefined) {
      return;
    }
    const existing = Object.values(useProjectStore.getState().folders)
      .filter((folder) => folder.apiId === apiId && folder.parentId === parentId)
      .map((folder) => folder.name);
    void useProjectStore
      .getState()
      .addFolder(apiId, parentId, nextName('Folder', existing))
      .then((folderId) => {
        startRenamingNode('folder', folderId);
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'New folder failed');
      });
  },

  /** Creates a REST request in an API or one of its folders and opens its editor. */
  newRestRequest(apiId: string | undefined, parentId?: string): void {
    if (apiId === undefined) {
      return;
    }
    void useProjectStore
      .getState()
      .addRestRequest(apiId, parentId)
      .then((requestId) => {
        openRestRequestTab(requestId);
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'New request failed');
      });
  },

  openRestRequest(requestId: string | undefined): void {
    if (requestId !== undefined) {
      openRestRequestTab(requestId);
    }
  },

  openApi(apiId: string | undefined): void {
    if (apiId !== undefined) {
      openApiTab(apiId);
    }
  },

  /** Copies a REST request beside the original and opens the copy. */
  duplicateRestRequest(requestId: string | undefined): void {
    if (requestId === undefined) {
      return;
    }
    void useProjectStore
      .getState()
      .cloneRestRequest(requestId)
      .then(openRestRequestTab)
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Duplicate request failed');
      });
  },

  /** Puts an API, folder or REST request row into inline rename mode. */
  renameNode(kind: 'api' | 'folder' | 'rest-request', id: string | undefined): void {
    if (id !== undefined) {
      startRenamingNode(kind, id);
    }
  },

  /** Opens a folder's credentials dialog, which is where a folder's one editable field lives. */
  editFolderAuth(folderId: string | undefined): void {
    if (folderId !== undefined) {
      useUiStore.getState().setFolderAuthId(folderId);
    }
  },

  /**
   * Deletes an API and everything in it. Always confirmed when it holds requests, whatever the
   * delete preference says: this is the one explorer action that can throw away a morning's work.
   */
  removeApi(apiId: string | undefined): void {
    if (apiId === undefined) {
      return;
    }
    const state = useProjectStore.getState();
    const api = state.apis[apiId];
    if (api === undefined) {
      return;
    }
    const requestCount = Object.values(state.restRequests).filter((request) => request.apiId === apiId).length;
    if (requestCount === 0 && !confirmsDeletes()) {
      void state.removeApi(apiId).catch(reportDeleteFailure);
      return;
    }
    useUiStore.getState().requestDeleteNode({ kind: 'api', id: apiId, name: api.name, requestCount });
  },

  /** Deletes a folder and everything in it, under the same rule as an API. */
  removeFolder(folderId: string | undefined): void {
    if (folderId === undefined) {
      return;
    }
    const state = useProjectStore.getState();
    const folder = state.folders[folderId];
    if (folder === undefined) {
      return;
    }
    const requestCount = Object.values(state.restRequests).filter((request) =>
      folderIdsUnder(folderId).has(request.folderId ?? ''),
    ).length;
    if (requestCount === 0 && !confirmsDeletes()) {
      void state.removeFolder(folderId).catch(reportDeleteFailure);
      return;
    }
    useUiStore.getState().requestDeleteNode({ kind: 'folder', id: folderId, name: folder.name, requestCount });
  },

  deleteRestRequest(requestId: string | undefined): void {
    if (requestId === undefined) {
      return;
    }
    const request = useProjectStore.getState().restRequests[requestId];
    if (request === undefined) {
      return;
    }
    if (!confirmsDeletes()) {
      void useProjectStore.getState().removeRestRequest(requestId).catch(reportDeleteFailure);
      return;
    }
    useUiStore
      .getState()
      .requestDeleteNode({ kind: 'rest-request', id: requestId, name: request.name, requestCount: 0 });
  },

  copyEndpointAddress(address: string | undefined): void {
    if (address !== undefined) {
      void navigator.clipboard.writeText(address);
    }
  },
};

/** `<base> N`, the first number not already taken — how a new API or folder is named. */
function nextName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; ; n += 1) {
    const candidate = `${base} ${String(n)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** One folder id and every folder id beneath it, so a delete can count what it would take. */
function folderIdsUnder(folderId: string): ReadonlySet<string> {
  const folders = Object.values(useProjectStore.getState().folders);
  const ids = new Set([folderId]);
  // Repeated passes rather than recursion: the list is flat, and a parent may appear after its
  // child. It settles as soon as a pass adds nothing.
  for (;;) {
    const before = ids.size;
    for (const folder of folders) {
      if (folder.parentId !== undefined && ids.has(folder.parentId)) {
        ids.add(folder.id);
      }
    }
    if (ids.size === before) {
      return ids;
    }
  }
}

function reportDeleteFailure(error: unknown): void {
  showToast(error instanceof Error ? error.message : 'Delete failed');
}
