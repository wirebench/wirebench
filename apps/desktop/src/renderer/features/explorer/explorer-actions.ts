import { showToast } from '../../components/toast.js';
import { openRequestTab, recreateRequest } from '../request-editor/request-actions.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { startRenamingRequest } from './explorer-api.js';
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

  copyEndpointAddress(address: string | undefined): void {
    if (address !== undefined) {
      void navigator.clipboard.writeText(address);
    }
  },
};
