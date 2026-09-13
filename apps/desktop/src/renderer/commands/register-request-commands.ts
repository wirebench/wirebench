import { getActiveRequestPaneHandle } from '../editor/active-request-editor.js';
import {
  addAttachmentsThroughPicker,
  removeSelectedAttachment,
} from '../features/request-editor/attachment-actions.js';
import { copyAsCurl, recreateRequest } from '../features/request-editor/request-actions.js';
import { openRequestDialog } from '../features/request-editor/request-dialogs.js';
import { validateAndReport } from '../features/request-editor/validate-actions.js';
import { addWsaHeadersToEditor, removeWsaHeadersFromEditor } from '../features/request-editor/wsa-actions.js';
import { checkWsiForRequest, lastSendId } from '../features/request-editor/wsi-actions.js';
import { applyOutgoingWssToEditor, removeOutgoingWssFromEditor } from '../features/request-editor/wss-actions.js';
import { showToast } from '../components/toast.js';
import { registerCommand } from '../lib/commands.js';
import { useEditorsStore } from '../state/editors.js';
import { useExchangesStore } from '../state/exchanges.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';
import { activeRequestId, activeRestRequestId, onActiveRequest, ui } from './command-helpers.js';

/** Registers every `request.*`/`response.*` command; all act on the active request tab. */
export function registerRequestCommands(): void {
  registerCommand({
    id: 'request.send',
    label: 'Send Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().send(requestId);
      }
    },
  });
  // A REST tab's own send. It shares `Mod+Enter` with `request.send` because the two can never be
  // active at once — a tab is one kind or the other — which is what the distinct `when` scopes say.
  registerCommand({
    id: 'rest.send',
    label: 'Send REST Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: () => {
      const requestId = activeRestRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().sendRest(requestId);
      }
    },
  });
  registerCommand({
    id: 'request.cancel',
    label: 'Cancel Request',
    category: 'Request',
    shortcut: 'Escape',
    // Escape must stay available to dialogs, menus, and the palette, so this command exists
    // only while the active request is actually in flight.
    whenScope: 'editor.request',
    when: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        return useExchangesStore.getState().byRequest[requestId]?.status === 'sending';
      }
      const restRequestId = activeRestRequestId();
      return (
        restRequestId !== undefined && useExchangesStore.getState().restByRequest[restRequestId]?.status === 'sending'
      );
    },
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().cancel(requestId);
        return;
      }
      const restRequestId = activeRestRequestId();
      if (restRequestId !== undefined) {
        void useExchangesStore.getState().cancelRest(restRequestId);
      }
    },
  });

  registerCommand({
    id: 'request.validate',
    label: 'Validate Request',
    category: 'Request',
    shortcut: 'Mod+Shift+V',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const requestId = activeRequestId();
      if (requestId === undefined) {
        return;
      }
      // Flush first: the debounced envelope edit may not have reached the store yet, and
      // validating a stale copy would put markers on lines the user has already changed.
      getActiveRequestPaneHandle()?.flush();
      void validateAndReport(requestId, 'request', useProjectStore.getState().requests[requestId]?.envelopeXml);
    },
  });
  registerCommand({
    id: 'response.validate',
    label: 'Validate Response',
    category: 'Request',
    whenScope: 'editor.request',
    when: () => {
      const requestId = activeRequestId();
      return (
        requestId !== undefined && useExchangesStore.getState().byRequest[requestId]?.exchange?.response !== undefined
      );
    },
    run: () => {
      const requestId = activeRequestId();
      const envelopeXml =
        requestId === undefined
          ? undefined
          : useExchangesStore.getState().byRequest[requestId]?.exchange?.response?.envelopeXml;
      if (requestId === undefined || envelopeXml === undefined) {
        return;
      }
      void validateAndReport(requestId, 'response', envelopeXml);
    },
  });

  registerCommand({
    id: 'request.checkWsi',
    label: 'Check WS-I compliance',
    category: 'Request',
    // The message assertions judge bytes on the wire, so there has to be an exchange to judge.
    whenScope: 'editor.request',
    when: () => {
      const requestId = activeRequestId();
      return requestId !== undefined && lastSendId(requestId) !== undefined;
    },
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void checkWsiForRequest(requestId);
      }
    },
  });

  // The request.* actions the pane's context menu offers, so the palette can reach them too.
  // All of them are gated the same way as `request.send`: they act on the active request tab.

  registerCommand({
    id: 'request.recreateKeepValues',
    label: 'Request: Recreate (keep values)',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'keep-values')),
  });
  registerCommand({
    id: 'request.recreateDiscardValues',
    label: 'Request: Recreate (discard values)',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'discard-values')),
  });
  registerCommand({
    id: 'request.createEmpty',
    label: 'Request: Create Empty Envelope',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'empty')),
  });
  registerCommand({
    id: 'request.clone',
    label: 'Request: Clone…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('clone', requestId);
    }),
  });
  registerCommand({
    id: 'request.copyCurl',
    label: 'Request: Copy as cURL',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void copyAsCurl(requestId, 'posix')),
  });
  registerCommand({
    id: 'request.copyCurlPowerShell',
    label: 'Request: Copy as cURL (PowerShell)',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void copyAsCurl(requestId, 'powershell')),
  });
  registerCommand({
    id: 'request.importCurl',
    label: 'Request: Import cURL…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('import-curl', requestId);
    }),
  });
  /*
   * The REST actions whose *handlers* belong to later tasks: exporting and importing a cURL command
   * (the engine has to learn both shapes first), getting an OAuth2 token from the inspector, and
   * importing an OpenAPI document.
   *
   * They are registered now, with the shortcut the design fixes, so the palette, the generated menu
   * and the keymap editor carry them from the moment the REST editor exists — a command that
   * appears later would move every shortcut around it. Each says what it is waiting for rather than
   * doing nothing silently.
   */
  const notYet = (what: string) => (): void => {
    showToast(`${what} is not built yet.`);
  };
  registerCommand({
    id: 'rest.copyAsCurl',
    label: 'REST: Copy as cURL',
    category: 'Request',
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: notYet('Copying a REST request as cURL'),
  });
  registerCommand({
    id: 'rest.importCurl',
    label: 'REST: Import cURL…',
    category: 'Request',
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: notYet('Importing a cURL command as a REST request'),
  });
  registerCommand({
    id: 'rest.getToken',
    label: 'REST: Get OAuth2 Token',
    category: 'Request',
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: notYet('Getting an OAuth2 token from the editor'),
  });
  registerCommand({
    id: 'rest.importOpenApi',
    label: 'REST: Import OpenAPI…',
    category: 'Definition',
    shortcut: 'Mod+Shift+I',
    run: () => {
      useUiStore.getState().setImportOpenApiDialogOpen(true);
    },
  });
  // The attachments inspector's two toolbar actions, reachable without opening the strip. Both
  // go through `attachmentActions`, so the palette and the inspector cannot drift apart.
  registerCommand({
    id: 'request.addAttachment',
    label: 'Request: Add Attachment…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void addAttachmentsThroughPicker(requestId)),
  });
  registerCommand({
    id: 'request.removeAttachment',
    label: 'Request: Remove Attachment',
    category: 'Request',
    whenScope: 'editor.request',
    when: () => {
      const requestId = activeRequestId();
      return requestId !== undefined && useEditorsStore.getState().selectedAttachmentFor(requestId) !== undefined;
    },
    run: onActiveRequest((requestId) => void removeSelectedAttachment(requestId)),
  });

  // The four WS-Security editor actions. Unlike the request's `wssOutgoingRef` (which applies a
  // configuration on its way to the wire), these bake a header into the envelope text itself.
  registerCommand({
    id: 'request.addWssUsernameToken',
    label: 'Request: Add WSS Username Token…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('wss-username-token', requestId);
    }),
  });
  registerCommand({
    id: 'request.addWsTimestamp',
    label: 'Request: Add WS-Timestamp…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('wss-timestamp', requestId);
    }),
  });
  registerCommand({
    id: 'request.applyOutgoingWss',
    label: 'Request: Outgoing WSS → Apply to Editor',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void applyOutgoingWssToEditor(requestId)),
  });
  registerCommand({
    id: 'request.removeOutgoingWss',
    label: 'Request: Outgoing WSS → Remove',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void removeOutgoingWssFromEditor(requestId)),
  });

  // The two WS-Addressing editor actions, the counterpart of the request's saved WS-A
  // configuration: these bake the headers into the envelope text rather than applying them on
  // the way to the wire.
  registerCommand({
    id: 'request.addWsaHeaders',
    label: 'Request: WS-A Headers → Add to Editor',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void addWsaHeadersToEditor(requestId)),
  });
  registerCommand({
    id: 'request.removeWsaHeaders',
    label: 'Request: WS-A Headers → Remove',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void removeWsaHeadersFromEditor(requestId)),
  });

  registerCommand({
    id: 'request.showCode',
    label: 'Request: Show Code',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      ui().openCode();
    },
  });
}
