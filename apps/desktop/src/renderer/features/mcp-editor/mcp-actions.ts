/**
 * Opening an MCP request's editor tab (#79). The tab's id — `mcp:<requestId>` — is fixed here: the
 * explorer, the commands, the persisted-tab restore and the store's cleanup all address it by it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one MCP request. */
export function mcpTabId(requestId: string): string {
  return `mcp:${requestId}`;
}

/** Opens (or focuses) the MCP request's tab. A request the mirror does not hold is ignored. */
export function openMcpRequestTab(requestId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().mcpRequests[requestId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: mcpTabId(requestId), kind: 'mcp-request', title, mcpRequestId: requestId });
}
