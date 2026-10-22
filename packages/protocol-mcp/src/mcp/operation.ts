/**
 * A saved MCP operation as the session sends it (#79): its params, the capability the server must
 * have advertised for it, and the check its result gets.
 *
 * Each result is validated against the SDK's schema for its method. A result that does not match is
 * a warning on the message that carried it and is kept as it came, never dropped: a test tool has
 * to show what the server really answered.
 */
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '#core/errors';
import { formatIssues } from './jsonrpc.js';
import type { McpMethod, McpOperation } from './model.js';
import { mcpArgumentsEmpty } from './shape.js';
import type { McpCapability, McpOperationCall } from './session.js';

/** The capability each method needs the server to have advertised in `initialize`. */
export const MCP_METHOD_CAPABILITY: Readonly<Record<McpMethod, McpCapability>> = {
  'tools/list': 'tools',
  'tools/call': 'tools',
  'resources/list': 'resources',
  'resources/templates/list': 'resources',
  'resources/read': 'resources',
  'prompts/list': 'prompts',
  'prompts/get': 'prompts',
};

/** The SDK's schema for each method's result. */
const RESULT_SCHEMAS = {
  'tools/list': ListToolsResultSchema,
  'tools/call': CallToolResultSchema,
  'resources/list': ListResourcesResultSchema,
  'resources/templates/list': ListResourceTemplatesResultSchema,
  'resources/read': ReadResourceResultSchema,
  'prompts/list': ListPromptsResultSchema,
  'prompts/get': GetPromptResultSchema,
} as const satisfies Record<McpMethod, unknown>;

/**
 * A call's arguments, parsed from the text as edited: blank text is `{}`.
 *
 * @throws McpError `mcp-arguments-invalid` when the text is not JSON, or not a JSON object
 */
export function parseMcpArguments(text: string): Record<string, unknown> {
  if (mcpArgumentsEmpty(text)) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new McpError('mcp-arguments-invalid', `The tool call's arguments are not JSON: ${reason}`, { cause: err });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpError('mcp-arguments-invalid', "The tool call's arguments must be a JSON object", {
      details: { type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value },
    });
  }
  return value as Record<string, unknown>;
}

/** The params of `operation`'s request; absent for the list methods, which send none. */
export function mcpOperationParams(operation: McpOperation): Record<string, unknown> | undefined {
  switch (operation.method) {
    case 'tools/call':
      return { name: operation.tool, arguments: parseMcpArguments(operation.arguments) };
    case 'resources/read':
      return { uri: operation.uri };
    case 'prompts/get': {
      // Prompt arguments are strings; a disabled row is not sent, and a later row wins over an earlier one.
      const enabled = operation.arguments.filter((entry) => entry.enabled && entry.name !== '');
      const args = Object.fromEntries(enabled.map((entry) => [entry.name, entry.value]));
      return { name: operation.prompt, ...(enabled.length > 0 ? { arguments: args } : {}) };
    }
    default:
      return undefined;
  }
}

/** What is wrong with `result` as an answer to `method`, one line per issue; none when it matches. */
export function mcpResultWarnings(method: McpMethod, result: unknown): string[] {
  const parsed = RESULT_SCHEMAS[method].safeParse(result);
  return parsed.success ? [] : formatIssues(`The ${method} result does not match the protocol`, parsed.error.issues);
}

/**
 * The call the session runs for `operation`.
 *
 * @throws McpError `mcp-arguments-invalid` for a `tools/call` whose arguments are not a JSON object
 */
export function mcpOperationCall(operation: McpOperation): McpOperationCall {
  const params = mcpOperationParams(operation);
  return {
    method: operation.method,
    ...(params !== undefined ? { params } : {}),
    capability: MCP_METHOD_CAPABILITY[operation.method],
    validateResult: (result) => mcpResultWarnings(operation.method, result),
  };
}
