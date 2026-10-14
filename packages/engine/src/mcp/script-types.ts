/**
 * An MCP request's script types (#79), from the tool it calls as the server's catalogue lists it:
 * `WbMcpArguments` from the tool's `inputSchema`, `WbMcpStructuredContent` from its `outputSchema`.
 * A request that calls no tool, or one the catalogue does not have, gets the untyped forms.
 */
import { JsonSchemaTypes } from '../script/types/json-schema.js';
import type { McpCatalogue, McpCatalogueTool, McpOperation } from './model.js';

/** `WbMcpArguments` and `WbMcpStructuredContent` for `tool`, or their untyped forms. */
export function mcpScriptTypes(tool: McpCatalogueTool | undefined): string {
  if (tool === undefined) {
    return [
      "// This request's tool is not in the server's catalogue, so its arguments and structured content are untyped.",
      'type WbMcpArguments = Record<string, unknown>;',
      'type WbMcpStructuredContent = unknown;',
      '',
    ].join('\n');
  }
  const types = new JsonSchemaTypes();
  const args = types.typeOf(tool.inputSchema);
  const structured = tool.outputSchema !== undefined ? types.typeOf(tool.outputSchema) : 'unknown';
  return [
    `// Types from the catalogue's tool ${JSON.stringify(tool.name).replace(/\*\//g, '*\\/')}.`,
    types.declarations(),
    `type WbMcpArguments = ${args};`,
    `type WbMcpStructuredContent = ${structured};`,
    '',
  ].join('\n');
}

/** The catalogue's entry for the tool `operation` calls; undefined for any other operation. */
export function mcpToolFor(catalogue: McpCatalogue | undefined, operation: McpOperation): McpCatalogueTool | undefined {
  if (operation.method !== 'tools/call') return undefined;
  return catalogue?.tools?.find((tool) => tool.name === operation.tool);
}
