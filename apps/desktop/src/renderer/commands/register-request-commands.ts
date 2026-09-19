import { catalogEntry } from '@shared/command-catalog.js';
import { getActiveRequestPaneHandle } from '../editor/active-request-editor.js';
import {
  addAttachmentsThroughPicker,
  removeSelectedAttachment,
} from '../features/request-editor/attachment-actions.js';
import { copyAsCurl, recreateRequest } from '../features/request-editor/request-actions.js';
import { getOAuth2Token } from '../features/rest-editor/rest-actions.js';
import { openRequestDialog } from '../features/request-editor/request-dialogs.js';
import { validateAndReport } from '../features/request-editor/validate-actions.js';
import { addWsaHeadersToEditor, removeWsaHeadersFromEditor } from '../features/request-editor/wsa-actions.js';
import { checkWsiForRequest, lastSendId } from '../features/request-editor/wsi-actions.js';
import { applyOutgoingWssToEditor, removeOutgoingWssFromEditor } from '../features/request-editor/wss-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useEditorsStore } from '../state/editors.js';
import { useExchangesStore } from '../state/exchanges.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';
import { activeGrpcRequestId, activeRequestId, activeRestRequestId, onActiveRequest, ui } from './command-helpers.js';

/** Registers every `request.*`/`response.*` command; all act on the active request tab. */
export function registerRequestCommands(): void {
  registerCommand({
    ...catalogEntry('request.send'),
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
    ...catalogEntry('rest.send'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: () => {
      const requestId = activeRestRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().sendRest(requestId);
      }
    },
  });
  // And a gRPC tab's, under the same chord for the same reason.
  registerCommand({
    ...catalogEntry('grpc.send'),
    when: () => activeGrpcRequestId() !== undefined,
    whenScope: 'editor.grpc',
    run: () => {
      const requestId = activeGrpcRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().sendGrpc(requestId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('request.cancel'),
    // Escape must stay available to dialogs, menus, and the palette, so this command exists
    // only while the active request is actually in flight.
    whenScope: 'editor.request',
    when: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        return useExchangesStore.getState().byRequest[requestId]?.status === 'sending';
      }
      const restRequestId = activeRestRequestId();
      if (restRequestId !== undefined) {
        return useExchangesStore.getState().restByRequest[restRequestId]?.status === 'sending';
      }
      const grpcRequestId = activeGrpcRequestId();
      return (
        grpcRequestId !== undefined && useExchangesStore.getState().grpcByRequest[grpcRequestId]?.status === 'sending'
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
        return;
      }
      const grpcRequestId = activeGrpcRequestId();
      if (grpcRequestId !== undefined) {
        void useExchangesStore.getState().cancelGrpc(grpcRequestId);
      }
    },
  });

  registerCommand({
    ...catalogEntry('request.validate'),
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
    ...catalogEntry('response.validate'),
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
    ...catalogEntry('request.checkWsi'),
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
    ...catalogEntry('request.recreateKeepValues'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'keep-values')),
  });
  registerCommand({
    ...catalogEntry('request.recreateDiscardValues'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'discard-values')),
  });
  registerCommand({
    ...catalogEntry('request.createEmpty'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'empty')),
  });
  registerCommand({
    ...catalogEntry('request.clone'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('clone', requestId);
    }),
  });
  registerCommand({
    ...catalogEntry('request.copyCurl'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void copyAsCurl(requestId, 'posix')),
  });
  registerCommand({
    ...catalogEntry('request.copyCurlPowerShell'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void copyAsCurl(requestId, 'powershell')),
  });
  registerCommand({
    ...catalogEntry('request.importCurl'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('import-curl', requestId);
    }),
  });
  // The REST counterparts of the SOAP cURL, token and import actions. Each goes through the same
  // channel its SOAP sibling does, so the palette and the panel can never mean different things.
  registerCommand({
    ...catalogEntry('rest.copyAsCurl'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    // The same `request.curl` the SOAP command uses, and the same shell the Code panel remembers:
    // the palette and the panel must never hand out two different commands for one request.
    run: () => {
      const requestId = activeRestRequestId();
      if (requestId !== undefined) {
        void copyAsCurl(requestId, ui().slideOver.codeShell);
      }
    },
  });
  registerCommand({
    ...catalogEntry('rest.importCurl'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: () => {
      const requestId = activeRestRequestId();
      const request = requestId === undefined ? undefined : useProjectStore.getState().restRequests[requestId];
      if (request !== undefined) {
        ui().setImportCurlTarget({
          kind: 'rest',
          apiId: request.apiId,
          ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
        });
      }
    },
  });
  registerCommand({
    ...catalogEntry('rest.getToken'),
    when: () => activeRestRequestId() !== undefined,
    whenScope: 'editor.rest',
    run: () => {
      void getOAuth2Token(activeRestRequestId());
    },
  });
  registerCommand({
    ...catalogEntry('rest.importOpenApi'),
    run: () => {
      useUiStore.getState().setImportOpenApiDialogOpen(true);
    },
  });
  // The gRPC counterparts: the same `request.curl` channel answers with a grpcurl-style command
  // for a gRPC request, and the Import dialog opens on its `.proto` format.
  registerCommand({
    ...catalogEntry('grpc.copyAsCommand'),
    when: () => activeGrpcRequestId() !== undefined,
    whenScope: 'editor.grpc',
    run: () => {
      const requestId = activeGrpcRequestId();
      if (requestId !== undefined) {
        void copyAsCurl(requestId, ui().slideOver.codeShell);
      }
    },
  });
  registerCommand({
    ...catalogEntry('grpc.importProto'),
    run: () => {
      useUiStore.getState().openImportDialog('proto');
    },
  });
  registerCommand({
    ...catalogEntry('rest.importPostman'),
    run: () => {
      useUiStore.getState().setImportPostmanDialogOpen(true);
    },
  });
  // The attachments inspector's two toolbar actions, reachable without opening the strip. Both
  // go through `attachmentActions`, so the palette and the inspector cannot drift apart.
  registerCommand({
    ...catalogEntry('request.addAttachment'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void addAttachmentsThroughPicker(requestId)),
  });
  registerCommand({
    ...catalogEntry('request.removeAttachment'),
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
    ...catalogEntry('request.addWssUsernameToken'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('wss-username-token', requestId);
    }),
  });
  registerCommand({
    ...catalogEntry('request.addWsTimestamp'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => {
      openRequestDialog('wss-timestamp', requestId);
    }),
  });
  registerCommand({
    ...catalogEntry('request.applyOutgoingWss'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void applyOutgoingWssToEditor(requestId)),
  });
  registerCommand({
    ...catalogEntry('request.removeOutgoingWss'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void removeOutgoingWssFromEditor(requestId)),
  });

  // The two WS-Addressing editor actions, the counterpart of the request's saved WS-A
  // configuration: these bake the headers into the envelope text rather than applying them on
  // the way to the wire.
  registerCommand({
    ...catalogEntry('request.addWsaHeaders'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void addWsaHeadersToEditor(requestId)),
  });
  registerCommand({
    ...catalogEntry('request.removeWsaHeaders'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: onActiveRequest((requestId) => void removeWsaHeadersFromEditor(requestId)),
  });

  registerCommand({
    ...catalogEntry('request.showCode'),
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      ui().openCode();
    },
  });
}
