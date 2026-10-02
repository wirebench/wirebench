/**
 * The ops as MCP tools (spec §4): one `McpServer` per connection, every op registered with its own
 * zod schema, gated tools always listed. A result is its JSON; a refusal is an `isError` result
 * carrying `{ code, message }`, never a protocol error, so the agent can read it and act.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { runOp } from '../ops/context.js';
import type { Op, OpsBase } from '../ops/context.js';
import { errorPayload, toOpsError } from '../ops/errors.js';
import { OPS } from '../ops/index.js';

export const SERVER_INSTRUCTIONS =
  'Wirebench tools over one project. send takes its SOAP, REST and WebSocket requests. Start with ' +
  'operations to learn the references the other tools take. send and import may be refused: the user starts the server with --allow-send or ' +
  '--allow-write to allow them. Secrets come from the environment the server was started in, and a ' +
  'resolved secret is masked wherever it appears in a result. Other values are redacted by pattern: ' +
  'credential headers, URL credentials and credential-named URL parameters, the WS-Security Password, ' +
  'and values under secret-looking JSON or form keys. A value outside those patterns is returned as it is.';

function resultOf(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function refusalOf(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorPayload(toOpsError(error))) }] };
}

function register(server: McpServer, op: Op<z.ZodObject, unknown>, base: OpsBase): void {
  server.registerTool(
    op.name,
    { title: op.title, description: op.description, inputSchema: op.input },
    async (args: unknown): Promise<CallToolResult> => {
      try {
        return resultOf(await runOp(op, args, base));
      } catch (error) {
        return refusalOf(error);
      }
    },
  );
}

export function createMcpServer(base: OpsBase, version: string): McpServer {
  const server = new McpServer({ name: 'wirebench', version }, { instructions: SERVER_INSTRUCTIONS });
  for (const op of Object.values(OPS)) {
    // Every op's input is a `z.object`, refined or not.
    register(server, op as Op<z.ZodObject, unknown>, base);
  }
  return server;
}
