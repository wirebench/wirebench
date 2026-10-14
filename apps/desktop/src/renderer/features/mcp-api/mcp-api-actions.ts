/**
 * Opening an MCP server's tab (#79). The id — `mcp-api:<apiId>` — is fixed here because the explorer,
 * the persisted-tab restore and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

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
