import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { startRenamingRequest } from './explorer-api.js';

/**
 * The logic behind every explorer action (right-click menu items and their `explorer.*` command
 * mirrors). Kept here, shared by both, so the palette and the context menu can never drift.
 */

function openRequestTab(requestId: string): void {
  const request = useProjectStore.getState().requests[requestId];
  if (request === undefined) {
    return;
  }
  useEditorsStore.getState().open({
    id: `request:${requestId}`,
    kind: 'request',
    title: request.name,
    requestId: request.id,
  });
}

export const explorerActions = {
  importAnother(): void {
    useUiStore.getState().openImportDialog();
  },

  removeInterface(interfaceId: string | undefined): void {
    if (interfaceId === undefined) {
      return;
    }
    useUiStore.getState().requestRemoveInterface(interfaceId);
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

  renameRequest(requestId: string | undefined): void {
    if (requestId !== undefined) {
      startRenamingRequest(requestId);
    }
  },

  deleteRequest(requestId: string | undefined): void {
    if (requestId === undefined) {
      return;
    }
    useUiStore.getState().requestDeleteRequest(requestId);
  },

  copyEndpointAddress(address: string | undefined): void {
    if (address !== undefined) {
      void navigator.clipboard.writeText(address);
    }
  },
};
