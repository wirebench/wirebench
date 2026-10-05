/**
 * The ops, and the project's contract operations, as MCP tools (#32 spec §4, #33 spec §8). The
 * contract tools carry JSON Schema built at run time, which `registerTool` cannot take, so this
 * server answers `tools/list` and `tools/call` itself on the underlying `Server`: the fixed tools
 * first, with the schema the SDK would have listed for their zod input, then the contract tools.
 * Gated tools are always listed. A result is its JSON; a refusal is an `isError` result carrying
 * `{ code, message }`, never a protocol error, so the agent can read it and act.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { callOp } from '../ops/call.js';
import { runOp } from '../ops/context.js';
import type { AnyOp, OpsBase } from '../ops/context.js';
import type { ContractTool } from '../ops/contract-tools.js';
import { errorPayload, OpsError, toOpsError } from '../ops/errors.js';
import { OPS } from '../ops/index.js';
import type { ContractToolsHost } from './contract-tools.js';

export const SERVER_INSTRUCTIONS =
  'Wirebench tools over one project. send takes its SOAP, REST and WebSocket requests. Start with ' +
  'operations to learn the references the other tools take. Every imported SOAP operation and REST endpoint is ' +
  'also a tool of its own, taking JSON arguments and returning the response as JSON. send, import and the ' +
  'operation tools may be refused: the user starts the server with --allow-send or ' +
  '--allow-write to allow them. Secrets come from the environment the server was started in, and a ' +
  'resolved secret is masked wherever it appears in a result. Other values are redacted by pattern: ' +
  'credential headers, URL credentials and credential-named URL parameters, the WS-Security Password, ' +
  'SAML token signatures and Kerberos tokens, and values under secret-looking JSON or form keys. A value ' +
  'outside those patterns is returned as it is.';

function resultOf(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function refusalOf(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorPayload(toOpsError(error))) }] };
}

function fixedTool(op: AnyOp): Tool {
  return {
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema: z.toJSONSchema(op.input, { target: 'draft-7', io: 'input' }) as Tool['inputSchema'],
  };
}

function contractTool(tool: ContractTool): Tool {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Tool['inputSchema'] };
}

const FIXED: Readonly<Record<string, AnyOp>> = OPS;

export function createMcpServer(base: OpsBase, version: string, host?: ContractToolsHost): McpServer {
  const server = new McpServer(
    { name: 'wirebench', version },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: true } } },
  );
  const fixed = Object.values(OPS).map(fixedTool);
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...fixed, ...(host?.current().tools ?? []).map(contractTool)],
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    try {
      // `hasOwn`, so a name such as `constructor` is no tool rather than an Object.prototype member.
      if (Object.hasOwn(FIXED, name)) {
        return resultOf(await runOp(FIXED[name] as AnyOp, args, base));
      }
      const tool = host?.current().tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        throw new OpsError('operation-gone', `No tool is named "${name}"; list the tools again`, { tool: name });
      }
      return resultOf(await runOp(callOp, { tool: tool.name, ref: tool.ref, args }, base));
    } catch (error) {
      return refusalOf(error);
    }
  });
  if (host !== undefined) {
    const unsubscribe = host.subscribe(() => {
      if (server.isConnected()) {
        // A session gone mid-send is closed by its transport; nothing to report here.
        void server.server.sendToolListChanged().catch(() => undefined);
      }
    });
    const previous = server.server.onclose;
    server.server.onclose = () => {
      unsubscribe();
      previous?.();
    };
  }
  return server;
}
