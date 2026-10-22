/**
 * What one MCP send recorded (#79), and the subject its assertions see.
 *
 * The exchange is the session's outcome with the transport's own record beside it: the HTTP calls
 * for the two HTTP transports, stderr and the exit code for stdio. It is plain data, so a history
 * entry or a report can keep it as it is. Values in it are expanded and may hold a secret; masking
 * them is the history entry's job, not this one's.
 */
import type { AssertionSubject } from '#core/assert/model';
import { mcpCatalogueChecks } from './check.js';
import type { McpHttpCall } from './http-calls.js';
import type { JsonRpcErrorObject } from './jsonrpc.js';
import type { McpCatalogue, McpMethod, McpOperation } from './model.js';
import type { McpMessage, McpSessionOutcome } from './session.js';
import type { McpWireTransport } from './transport.js';

/** The transport an exchange went over, as it was expanded for the send. */
export type McpExchangeTransport =
  | {
      readonly type: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      /** Absolute. */
      readonly cwd: string;
      /** The transport's own variables; the inherited parent ones are not recorded. */
      readonly env: Readonly<Record<string, string>>;
    }
  | { readonly type: 'http' | 'sse'; readonly url: string };

/** A completed MCP send. */
export interface McpExchange {
  readonly kind: 'mcp';
  readonly transport: McpExchangeTransport;
  readonly method: McpMethod;
  /** ISO 8601. */
  readonly startedAt: string;
  readonly durationMs: number;
  /** The server's `initialize` result, as it came. */
  readonly initialize?: Readonly<Record<string, unknown>>;
  readonly protocolVersion?: string;
  /** At most `MCP_MAX_MESSAGES`, the first ones; the rest are counted in {@link droppedMessages}. */
  readonly messages: readonly McpMessage[];
  readonly droppedMessages: number;
  /** HTTP only: every call, in the order they started. */
  readonly httpCalls?: readonly McpHttpCall[];
  /** stdio only: stderr's last 64 KiB. */
  readonly stderr?: string;
  readonly stderrTruncated?: boolean;
  /** stdio only: null while running, and when a signal ended the process. */
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  /** The operation's answer: one of these two, or neither when the session failed first. */
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
  /** Why the session could not finish; absent when it did. */
  readonly failure?: { readonly code: string; readonly message: string };
  /** Checks against the catalogue that found something: the arguments, the structured content. */
  readonly warnings: readonly string[];
}

/** What a stdio wire transport records about its process. */
interface StdioRecord {
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

/** What {@link buildMcpExchange} is given. */
export interface BuildMcpExchangeInput {
  readonly transport: McpExchangeTransport;
  /** The wire transport the session ran over; read for its calls, or its stderr and exit code. */
  readonly wire: McpWireTransport;
  /** The operation as it was sent, expanded. */
  readonly operation: McpOperation;
  readonly outcome: McpSessionOutcome;
  /** The server's catalogue, for the checks against the tool's schemas. */
  readonly catalogue?: McpCatalogue;
}

const hasCalls = (wire: McpWireTransport): wire is McpWireTransport & { readonly calls: readonly McpHttpCall[] } =>
  Array.isArray((wire as { calls?: unknown }).calls);

const hasStderr = (wire: McpWireTransport): wire is McpWireTransport & StdioRecord =>
  typeof (wire as { stderr?: unknown }).stderr === 'string';

/** The exchange of a finished session. */
export function buildMcpExchange(input: BuildMcpExchangeInput): McpExchange {
  const { outcome, wire } = input;
  const response = outcome.response;
  const warnings = mcpCatalogueChecks({
    operation: input.operation,
    ...(response !== undefined && 'result' in response ? { result: response.result } : {}),
    ...(input.catalogue !== undefined ? { catalogue: input.catalogue } : {}),
  });
  const stdio =
    input.transport.type === 'stdio' && hasStderr(wire)
      ? {
          stderr: wire.stderr,
          stderrTruncated: wire.stderrTruncated,
          exitCode: wire.exitCode,
          exitSignal: wire.exitSignal,
        }
      : {};
  return {
    kind: 'mcp',
    transport: input.transport,
    method: input.operation.method,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    ...(outcome.initialize !== undefined ? { initialize: outcome.initialize } : {}),
    ...(outcome.protocolVersion !== undefined ? { protocolVersion: outcome.protocolVersion } : {}),
    messages: outcome.messages,
    droppedMessages: outcome.droppedMessages,
    ...(input.transport.type !== 'stdio' && hasCalls(wire) ? { httpCalls: wire.calls } : {}),
    ...stdio,
    ...(response !== undefined && 'result' in response ? { result: response.result } : {}),
    ...(response !== undefined && 'error' in response ? { error: response.error } : {}),
    ...(outcome.failure !== undefined
      ? { failure: { code: outcome.failure.code, message: outcome.failure.message } }
      : {}),
    warnings,
  };
}

/** The `POST` that carried the operation's request: the last one with its method. */
export function mcpOperationPost(exchange: McpExchange): McpHttpCall | undefined {
  return exchange.httpCalls?.findLast((call) => call.method === 'POST' && call.message?.method === exchange.method);
}

/**
 * The subject an MCP request's assertions see: the operation's `result` as JSON, or
 * `{"error": {…}}`; the headers of the `POST` that carried the operation (none for stdio); and, for
 * Streamable HTTP, that `POST`'s status. The legacy transport answers every `POST` with 202, the
 * result coming over the stream, and stdio has no status, so both read as 0.
 */
export function mcpSubject(exchange: McpExchange): AssertionSubject {
  const answered = 'result' in exchange || exchange.error !== undefined;
  const body = exchange.error !== undefined ? { error: exchange.error } : (exchange.result ?? null);
  const call = mcpOperationPost(exchange);
  return {
    protocol: 'mcp',
    status: exchange.transport.type === 'http' ? (call?.status ?? 0) : 0,
    durationMs: exchange.durationMs,
    bodyText: answered ? JSON.stringify(body) : '',
    bodyKind: answered ? 'json' : 'other',
    headers: Object.entries(call?.responseHeaders ?? {}),
  };
}
