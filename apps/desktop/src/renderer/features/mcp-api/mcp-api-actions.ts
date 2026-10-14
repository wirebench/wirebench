/**
 * Opening an MCP server's tab, and a request from one of its tools (#79). The tab's id —
 * `mcp-api:<apiId>` — is fixed here because the explorer, the persisted-tab restore and the store's
 * cleanup all use it.
 */
import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';
import { openMcpRequestTab } from '../mcp-editor/mcp-actions.js';

/** The editor-tab id for one MCP server. */
export function mcpApiTabId(apiId: string): string {
  return `mcp-api:${apiId}`;
}

/** Opens (or focuses) the MCP server's tab. A server the mirror does not hold is ignored. */
export function openMcpApiTab(apiId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().mcpServers[apiId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: mcpApiTabId(apiId), kind: 'mcp-api', title, mcpApiId: apiId });
}

/**
 * Makes a `tools/call` request for one catalogued tool, named after it and with no arguments yet, and
 * opens it: what *New request from tool…* and a tool row of the server tab both do. A failure is a toast.
 */
export function newMcpRequestFromTool(apiId: string, tool: string): void {
  void useProjectStore
    .getState()
    .addMcpRequest(apiId, undefined, tool, { method: 'tools/call', tool, arguments: '' })
    .then((requestId) => {
      openMcpRequestTab(requestId);
    })
    .catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'New request failed');
    });
}
