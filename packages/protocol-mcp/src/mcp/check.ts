/**
 * The checks an MCP send gets of its own (#79), beside the request's assertions.
 *
 * - **"MCP result"**, a run check: it fails on a JSON-RPC error, and on a `tools/call` result with
 *   `isError: true`. Like the GraphQL errors check it is not an assertion of the request's, so it
 *   does not count for `--require-assertions`.
 * - **Against the catalogue**, warnings only: the arguments against the tool's `inputSchema`, and a
 *   `structuredContent` against its `outputSchema`. Sending bad input on purpose is a test, so a
 *   mismatch never refuses the send. Messages name the schema's side only: no value from the
 *   arguments or the result is copied into one.
 */
import type { AssertionResult } from '#core/assert/model';
import { validateJsonSchema } from '#core/json/schema-validate';
import type { JsonRpcErrorObject } from './jsonrpc.js';
import type { McpCatalogue, McpCatalogueTool, McpMethod, McpOperation } from './model.js';
import { parseMcpArguments } from './operation.js';

/** The label of the run check. */
export const MCP_RESULT_CHECK = 'MCP result';

const MAX_ACTUAL = 300;

const cap = (text: string): string => (text.length <= MAX_ACTUAL ? text : `${text.slice(0, MAX_ACTUAL - 1)}…`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of a tool result's first `text` content item; absent when it has none. */
export function firstTextContent(result: unknown): string | undefined {
  const content = isRecord(result) ? result['content'] : undefined;
  if (!Array.isArray(content)) return undefined;
  for (const item of content as unknown[]) {
    if (isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string') return item['text'];
  }
  return undefined;
}

/** What {@link checkMcpResult} reads of an exchange. */
export interface McpResultCheckInput {
  readonly method: McpMethod;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

/** The run's "MCP result" check of one exchange. */
export function checkMcpResult(exchange: McpResultCheckInput): AssertionResult {
  const base = { type: 'mcp', label: MCP_RESULT_CHECK, expected: 'no error' } as const;
  if (exchange.error !== undefined) {
    const { code, message } = exchange.error;
    return { ...base, outcome: 'failed', actual: cap(`Error ${String(code)} ${message}`.trimEnd()) };
  }
  if (!('result' in exchange)) return { ...base, outcome: 'failed', actual: 'no answer' };
  if (exchange.method === 'tools/call' && isRecord(exchange.result) && exchange.result['isError'] === true) {
    return { ...base, outcome: 'failed', actual: cap(firstTextContent(exchange.result) ?? 'isError: true') };
  }
  return { ...base, outcome: 'passed', actual: 'OK' };
}

/** The catalogue's entry for `name`; absent when the catalogue has no such tool. */
export function mcpCatalogueTool(catalogue: McpCatalogue | undefined, name: string): McpCatalogueTool | undefined {
  return catalogue?.tools?.find((tool) => tool.name === name);
}

/** `value` against `schema`, as warning lines that start with `lead`. */
function schemaWarnings(lead: string, value: unknown, schema: unknown): string[] {
  return validateJsonSchema(value, schema, { redactValues: true }).map(
    (problem) => `${lead}${problem.path !== '' ? ` at ${problem.path}` : ''}: ${problem.message}`,
  );
}

/** What {@link mcpCatalogueChecks} is given. */
export interface McpCatalogueCheckInput {
  /** The operation as sent, expanded. */
  readonly operation: McpOperation;
  /** The operation's result, when the server answered with one. */
  readonly result?: unknown;
  readonly catalogue?: McpCatalogue;
}

/**
 * A `tools/call` checked against the catalogue's entry for its tool, as warnings: the arguments
 * against `inputSchema`, and the result's `structuredContent` against `outputSchema`. Nothing for
 * any other method, or a tool the catalogue does not have.
 */
export function mcpCatalogueChecks(input: McpCatalogueCheckInput): string[] {
  const { operation } = input;
  if (operation.method !== 'tools/call') return [];
  const tool = mcpCatalogueTool(input.catalogue, operation.tool);
  if (tool === undefined) return [];
  const warnings: string[] = [];
  let args: Record<string, unknown> | undefined;
  try {
    args = parseMcpArguments(operation.arguments);
  } catch {
    // Arguments that are not an object were never sent; the send failed on them before this.
  }
  if (args !== undefined) {
    warnings.push(
      ...schemaWarnings(`The arguments do not match the inputSchema of "${tool.name}"`, args, tool.inputSchema),
    );
  }
  const result = input.result;
  if (tool.outputSchema !== undefined && isRecord(result) && result['isError'] !== true) {
    if (!('structuredContent' in result)) {
      warnings.push(`The result of "${tool.name}" has no structuredContent, which its outputSchema calls for`);
    } else {
      warnings.push(
        ...schemaWarnings(
          `The structuredContent does not match the outputSchema of "${tool.name}"`,
          result['structuredContent'],
          tool.outputSchema,
        ),
      );
    }
  }
  return warnings;
}
