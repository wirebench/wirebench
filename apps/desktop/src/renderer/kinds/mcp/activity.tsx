import { lazy } from 'react';
import type { HistoryEntryWire } from '@shared/wire-types.js';
import { openMcpRequestTab } from '../../features/mcp-editor/mcp-actions.js';
import { mcpMethodLabel } from '../../features/mcp-editor/method-label.js';
import type { KindHistory, KindLog, KindRequests, KindSearch } from '../renderer-kind.js';

// Split out with the History entry tab it is drawn in.
const McpHistoryBody = lazy(async () => {
  const module = await import('./history-body.js');
  return { default: module.McpHistoryBody };
});

export const mcpRequests: KindRequests = {
  open: openMcpRequestTab,
  exists: (requestId, project) => project.mcpRequests[requestId] !== undefined,
  quickOpen: (project) =>
    Object.values(project.mcpRequests).map((request) => {
      const operation = request.operation;
      const target =
        operation.method === 'tools/call'
          ? operation.tool
          : operation.method === 'resources/read'
            ? operation.uri
            : operation.method === 'prompts/get'
              ? operation.prompt
              : '';
      return {
        id: request.id,
        tag: 'MCP',
        name: request.name,
        apiId: request.apiId,
        apiName: project.mcpServers[request.apiId]?.name ?? 'MCP server',
        ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
        match: `${operation.method} ${target}`.trim(),
      };
    }),
};

function McpHistoryBadge({ entry, place }: { readonly entry: HistoryEntryWire; readonly place: 'row' | 'header' }) {
  const label = entry.mcp === undefined ? 'MCP' : mcpMethodLabel(entry.mcp.method);
  return place === 'row' ? (
    <span data-testid="history-mcp-badge" className="w-12 shrink-0 text-fg-faint">
      {label}
    </span>
  ) : (
    <span className="text-xs text-fg-faint">MCP {label}</span>
  );
}

export const mcpHistory: KindHistory = {
  Badge: McpHistoryBadge,
  Body: McpHistoryBody,
  hasBody: (entry) => entry.mcp !== undefined,
  // A re-send would need the stdio approval too; this slice opens an entry but does not re-send it.
  canResend: () => false,
};

export const mcpSearch: KindSearch = { badge: 'MCP' };

// MCP sends are not written to the HTTP Log (History is their record), so it has no row to explain.
export const mcpLog: KindLog = {
  noResend: 'An MCP request is sent again from its tab',
  noBody: 'An MCP session is in History',
};
