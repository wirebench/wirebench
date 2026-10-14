import { activeMcpRequestId, folderOf, insideKindApi } from '../../commands/command-helpers.js';
import { catalogEntry } from '@shared/command-catalog.js';
import { explorerActions } from '../../features/explorer/explorer-actions.js';
import { registerCommand } from '../../lib/commands.js';
import { useExchangesStore } from '../../state/exchanges.js';

/** Registers MCP's own commands (kind modules spec §6.1; #79). */
export function registerMcpCommands(): void {
  registerCommand({
    ...catalogEntry('mcp.newServer'),
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newMcpServer(ctx.selection?.id);
    },
  });
  registerCommand({
    ...catalogEntry('mcp.newRequest'),
    when: (ctx) => insideKindApi('mcp', ctx.selection),
    whenScope: 'selection.mcpApi',
    run: (ctx) => {
      explorerActions.newMcpRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
  // The server's own actions, offered on its row.
  registerCommand({
    ...catalogEntry('mcp.refreshCatalogue'),
    when: (ctx) => ctx.selection?.kind === 'mcp-api',
    whenScope: 'selection.mcpServer',
    run: (ctx) => {
      explorerActions.refreshMcpCatalogue(ctx.selection?.apiId);
    },
  });
  registerCommand({
    ...catalogEntry('mcp.newRequestFromTool'),
    when: (ctx) => ctx.selection?.kind === 'mcp-api',
    whenScope: 'selection.mcpServer',
    run: (ctx) => {
      explorerActions.newMcpRequestFromTool(ctx.selection?.apiId);
    },
  });
  // An MCP tab's send, under the chord every editor sends with.
  registerCommand({
    ...catalogEntry('mcp.send'),
    when: () => activeMcpRequestId() !== undefined,
    whenScope: 'editor.mcp',
    run: () => {
      const requestId = activeMcpRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().sendMcp(requestId);
      }
    },
  });
  registerCommand({
    ...catalogEntry('mcp.cancel'),
    when: () => {
      const requestId = activeMcpRequestId();
      return requestId !== undefined && useExchangesStore.getState().mcpByRequest[requestId]?.status === 'sending';
    },
    whenScope: 'editor.mcp',
    run: () => {
      const requestId = activeMcpRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().cancelMcp(requestId);
      }
    },
  });
}
