/**
 * The badge before an MCP request's name (#79): its method's short form, in the column and weight
 * the REST method badge and the WebSocket badge use, so a project mixing kinds reads as one tree.
 */
import { mcpMethodLabel } from './method-label.js';

export interface McpBadgeProps {
  /** The operation's JSON-RPC method: `tools/call`, `resources/read`, `prompts/get` or a list. */
  readonly method: string;
  readonly className?: string;
}

export function McpBadge({ method, className }: McpBadgeProps) {
  const label = mcpMethodLabel(method);
  return (
    <span
      data-testid="mcp-badge"
      data-method={label}
      title={`MCP ${method}`}
      className={`shrink-0 font-mono text-2xs font-bold leading-none text-method-other ${className ?? ''}`}
    >
      {label}
    </span>
  );
}
