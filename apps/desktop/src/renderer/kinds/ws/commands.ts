import { kindTarget } from '../../commands/command-helpers.js';
import { catalogEntry } from '@shared/command-catalog.js';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { registerCommand } from '../../lib/commands.js';
import { useExchangesStore } from '../../state/exchanges.js';
import {
  connectOrSendWs,
  copyWsCommand,
  sendSelectedWsMessageReporting,
} from '../../features/ws-editor/ws-session-actions.js';
import { activeWsRequestId, ui } from '../../commands/command-helpers.js';

/** Registers WebSocket's own commands (kind modules spec §6.1). */
export function registerWsCommands(): void {
  registerCommand({
    ...catalogEntry('ws.newApi'),
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newWsApi(ctx.selection?.id);
    },
  });
  registerCommand({
    ...catalogEntry('ws.newRequest'),
    when: (ctx) => kindTarget('websocket', ctx.selection) !== undefined,
    whenScope: 'selection.wsApi',
    run: (ctx) => {
      const target = kindTarget('websocket', ctx.selection);
      explorerActions.newWsRequest(target?.apiId, target?.folderId);
    },
  });
  // A WebSocket tab's `Mod+Enter` is its next step: connect a closed session, or send the selected
  // saved message on an open one. The composer handles the chord itself and stops it there.
  registerCommand({
    ...catalogEntry('ws.connect'),
    when: () => activeWsRequestId() !== undefined,
    whenScope: 'editor.ws',
    run: () => {
      const requestId = activeWsRequestId();
      if (requestId !== undefined) {
        connectOrSendWs(requestId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('ws.disconnect'),
    when: () => {
      const requestId = activeWsRequestId();
      return requestId !== undefined && useExchangesStore.getState().wsByRequest[requestId]?.status === 'open';
    },
    whenScope: 'editor.ws',
    run: () => {
      const requestId = activeWsRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().disconnectWs(requestId, 1000);
      }
    },
  });
  registerCommand({
    ...catalogEntry('ws.sendMessage'),
    when: () => {
      const requestId = activeWsRequestId();
      return requestId !== undefined && useExchangesStore.getState().wsByRequest[requestId]?.status === 'open';
    },
    whenScope: 'editor.ws',
    run: () => {
      const requestId = activeWsRequestId();
      if (requestId !== undefined) {
        void sendSelectedWsMessageReporting(requestId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('ws.copyAsCommand'),
    when: () => activeWsRequestId() !== undefined,
    whenScope: 'editor.ws',
    run: () => {
      const requestId = activeWsRequestId();
      if (requestId !== undefined) {
        void copyWsCommand(requestId, ui().slideOver.codeShell);
      }
    },
  });
}
