/**
 * An MCP server's tab (#79). A holding view until the connection and catalogue sections arrive: it
 * says how the server is reached and when its catalogue was fetched. Loaded lazily.
 */
import { EmptyState } from '../../components/empty-state.js';
import { useProjectStore } from '../../state/project.js';

export function McpApiTab({ apiId }: { readonly apiId: string }) {
  const server = useProjectStore((state) => state.mcpServers[apiId]);
  if (server === undefined) {
    return <EmptyState title="Server not found" description="This MCP server is no longer in the project." />;
  }
  const { transport, catalogueInfo } = server;
  const reach =
    transport.type === 'stdio'
      ? [transport.command, ...transport.args].join(' ')
      : `${transport.type} ${transport.url}`;
  return (
    <div data-testid="mcp-api-tab" className="flex h-full flex-col gap-1 p-4">
      <h2 className="text-lg font-medium text-fg-default">{server.name}</h2>
      <p className="font-mono text-sm text-fg-muted">{reach}</p>
      {catalogueInfo !== undefined && (
        <p className="text-sm text-fg-subtle">
          Fetched {catalogueInfo.fetchedAt} from {catalogueInfo.serverInfo.name} {catalogueInfo.serverInfo.version}
        </p>
      )}
    </div>
  );
}
