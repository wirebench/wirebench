/**
 * The MCP request tab (#79). A holding view until the editor (its operation bar, arguments and
 * settings) arrives: it says which operation the request runs. Loaded lazily, as every editor is.
 */
import { EmptyState } from '../../components/empty-state.js';
import { useProjectStore } from '../../state/project.js';

export function McpEditor({ requestId }: { readonly requestId: string }) {
  const request = useProjectStore((state) => state.mcpRequests[requestId]);
  if (request === undefined) {
    return <EmptyState title="Request not found" description="This MCP request is no longer in the project." />;
  }
  const { operation } = request;
  const target =
    operation.method === 'tools/call'
      ? operation.tool
      : operation.method === 'prompts/get'
        ? operation.prompt
        : operation.method === 'resources/read'
          ? operation.uri
          : undefined;
  return (
    <div data-testid="mcp-editor" className="flex h-full flex-col gap-1 p-4">
      <h2 className="text-lg font-medium text-fg-default">{request.name}</h2>
      <p className="font-mono text-sm text-fg-muted">
        {operation.method}
        {target !== undefined && target !== '' ? ` ${target}` : ''}
      </p>
    </div>
  );
}
