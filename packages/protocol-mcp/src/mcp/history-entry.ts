/**
 * One MCP send as History records it (#79), for every host that writes History: the desktop after a
 * send, the command line's `send`. Redaction is History's, whatever was shown live.
 *
 * A session's messages are capped as a WebSocket session's frames are: both ends kept, then a byte
 * budget, since the end of a session (the answer, or the last messages before the server died) is
 * what a person comes back for.
 */
import { capByEnds, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from '#core/http/transcript-cap';
import { generateHistoryId } from '#core/project/history';
import type { HistoryEntry, HistoryHeader, HistoryMcp } from '#core/project/history';
import { redactHeaders, redactUrl } from '#core/redact/index';
import { commandDisplay } from './approval.js';
import { mcpOperationPost } from './exchange.js';
import type { McpExchange, McpExchangeTransport } from './exchange.js';
import type { McpHttpCall } from './http-calls.js';
import type { JsonRpcErrorObject } from './jsonrpc.js';
import type { McpMessage } from './session.js';

/** A result whose JSON is larger than this is not kept beside the message that carried it. */
export const MCP_HISTORY_RESULT_BYTES = 256 * 1024;

/** What History keeps of a session's messages. */
export interface McpTranscript {
  readonly messages: readonly McpMessage[];
  readonly truncated: boolean;
  readonly omittedMessages: number;
}

/** Caps a session's messages at both ends, then strips the text of any that would blow the byte budget. */
export function capMcpMessages(input: readonly McpMessage[]): McpTranscript {
  const r = capByEnds(
    input,
    { head: WS_HISTORY_HEAD, tail: WS_HISTORY_TAIL, maxBytes: WS_HISTORY_MAX_BYTES },
    (message) => message.size,
    (message) => (message.text === '' ? undefined : { ...message, text: '', payloadTruncated: true as const }),
  );
  return { messages: r.items, truncated: r.truncated, omittedMessages: r.omitted };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The server's `serverInfo` from its `initialize` result, when it is the shape the protocol gives it. */
export function mcpServerInfo(exchange: McpExchange): HistoryMcp['serverInfo'] {
  const info = exchange.initialize?.['serverInfo'];
  if (!isRecord(info) || typeof info['name'] !== 'string' || typeof info['version'] !== 'string') return undefined;
  return { name: info['name'], version: info['version'] };
}

/** True for a `tools/call` result that says it failed (`isError: true`). */
export function mcpResultIsError(result: unknown): boolean {
  return isRecord(result) && result['isError'] === true;
}

/** Builds a {@link HistoryMcp} from a completed send, applying {@link capMcpMessages}. */
export function historyMcpOf(exchange: McpExchange): HistoryMcp {
  const { messages, truncated, omittedMessages } = capMcpMessages(exchange.messages);
  const serverInfo = mcpServerInfo(exchange);
  const answered = 'result' in exchange;
  const resultText = answered ? (JSON.stringify(exchange.result) ?? '') : '';
  const keepResult = answered && Buffer.byteLength(resultText, 'utf8') <= MCP_HISTORY_RESULT_BYTES;
  return {
    transport: exchange.transport,
    method: exchange.method,
    startedAt: exchange.startedAt,
    ...(exchange.protocolVersion !== undefined ? { protocolVersion: exchange.protocolVersion } : {}),
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    messages,
    droppedMessages: exchange.droppedMessages,
    ...(truncated ? { truncated: true, ...(omittedMessages > 0 ? { omittedMessages } : {}) } : {}),
    ...(exchange.httpCalls !== undefined ? { httpCalls: exchange.httpCalls } : {}),
    ...(exchange.stderr !== undefined ? { stderr: exchange.stderr } : {}),
    ...(exchange.stderrTruncated !== undefined ? { stderrTruncated: exchange.stderrTruncated } : {}),
    ...(exchange.exitCode !== undefined ? { exitCode: exchange.exitCode } : {}),
    ...(exchange.exitSignal !== undefined ? { exitSignal: exchange.exitSignal } : {}),
    ...(keepResult ? { result: exchange.result } : answered ? { resultOmitted: true } : {}),
    ...(exchange.error !== undefined ? { error: exchange.error } : {}),
    ...(exchange.failure !== undefined ? { failure: exchange.failure } : {}),
    warnings: exchange.warnings,
  };
}

/** The secret values the host knows of, masked wherever no pattern rule looks. */
export interface McpHistoryMasks {
  /** Masks each value in a text: a message, a header, the URL, an argument, stderr. */
  readonly text: (text: string) => string;
}

/** `value` with every string in it masked, keys left alone. */
function maskValue(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, mask));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, maskValue(inner, mask)]));
  }
  return value;
}

/**
 * A send as History stores it. Header values are redacted by pattern with `show: false` (the
 * credential headers and cookies), then masked, as are the URLs, with their credential query
 * parameters redacted. The stdio command, arguments, folder and every variable's value are masked;
 * so are each message's text, the result, the error, stderr, the failure and the warnings. A
 * message's `size` stays its size on the wire. A host that shows the send where History's rules
 * apply (the command line's `send` result) reads it from here too.
 */
export function redactMcpExchange(exchange: McpExchange, masks: McpHistoryMasks): McpExchange {
  const mask = masks.text;
  const url = (value: string): string => mask(redactUrl(value, { show: false }));
  const headers = (values: Readonly<Record<string, string>>): Record<string, string> => {
    const out = redactHeaders(values, { show: false });
    for (const [name, value] of Object.entries(out)) out[name] = mask(value);
    return out;
  };
  const transport: McpExchangeTransport =
    exchange.transport.type === 'stdio'
      ? {
          type: 'stdio',
          command: mask(exchange.transport.command),
          args: exchange.transport.args.map(mask),
          cwd: mask(exchange.transport.cwd),
          env: Object.fromEntries(Object.entries(exchange.transport.env).map(([name, value]) => [name, mask(value)])),
        }
      : { type: exchange.transport.type, url: url(exchange.transport.url) };
  const call = (one: McpHttpCall): McpHttpCall => ({
    ...one,
    url: url(one.url),
    requestHeaders: headers(one.requestHeaders),
    responseHeaders: headers(one.responseHeaders),
    ...(one.error !== undefined ? { error: mask(one.error) } : {}),
  });
  const error = (value: JsonRpcErrorObject): JsonRpcErrorObject => ({
    code: value.code,
    message: mask(value.message),
    ...('data' in value ? { data: maskValue(value.data, mask) } : {}),
  });
  return {
    ...exchange,
    transport,
    ...(exchange.initialize !== undefined
      ? { initialize: maskValue(exchange.initialize, mask) as Record<string, unknown> }
      : {}),
    messages: exchange.messages.map((message) => ({
      ...message,
      text: mask(message.text),
      warnings: message.warnings.map(mask),
    })),
    ...(exchange.httpCalls !== undefined ? { httpCalls: exchange.httpCalls.map(call) } : {}),
    ...(exchange.stderr !== undefined ? { stderr: mask(exchange.stderr) } : {}),
    ...('result' in exchange ? { result: maskValue(exchange.result, mask) } : {}),
    ...(exchange.error !== undefined ? { error: error(exchange.error) } : {}),
    ...(exchange.failure !== undefined
      ? { failure: { code: exchange.failure.code, message: mask(exchange.failure.message) } }
      : {}),
    warnings: exchange.warnings.map(mask),
  };
}

/** What {@link buildMcpHistoryEntry} needs to build one MCP entry. */
export interface McpHistoryInput {
  readonly requestId: string;
  readonly requestName: string;
  /** The server the request belongs to, in the interface name's slot. */
  readonly serverName: string;
  readonly folderPath: string;
  readonly exchange: McpExchange;
  /** Where the entry came from, or the run it belongs to: `cli`, `sequence:<id>`. */
  readonly tags?: readonly string[];
}

/** The operation's own request message, and the message that answered it. */
function operationMessages(exchange: McpExchange): { sent?: McpMessage; answer?: McpMessage } {
  const ofMethod = (message: McpMessage): boolean => message.method === exchange.method;
  const sent = exchange.messages.find((m) => m.direction === 'sent' && m.kind === 'request' && ofMethod(m));
  const answer = exchange.messages.find(
    (m) => m.direction === 'received' && (m.kind === 'result' || m.kind === 'error') && ofMethod(m),
  );
  return { ...(sent !== undefined ? { sent } : {}), ...(answer !== undefined ? { answer } : {}) };
}

/**
 * Builds one redacted MCP `HistoryEntry` from a finished send, whether the server answered or the
 * session failed first. The SOAP-shaped fields carry what they can, as a WebSocket entry's do: the
 * server's name as the interface, the folder path as the operation, the URL (or the command line) as
 * the endpoint, the JSON-RPC method as the method, the status of the `POST` that carried the
 * operation as the status; the operation's request and its answer as the two bodies. `mcp` is the
 * session's record, capped by {@link historyMcpOf}. `ok` holds for an answer that is neither a
 * JSON-RPC error nor a result with `isError: true`. Redacted by {@link redactMcpExchange}.
 */
export function buildMcpHistoryEntry(projectId: string, record: McpHistoryInput, masks: McpHistoryMasks): HistoryEntry {
  const redacted = redactMcpExchange(record.exchange, masks);
  const mcp = historyMcpOf(redacted);
  const { transport } = redacted;
  const post = mcpOperationPost(redacted);
  const { sent, answer } = operationMessages(redacted);
  const answered = 'result' in redacted || redacted.error !== undefined;
  const requestHeaders: HistoryHeader[] = Object.entries(post?.requestHeaders ?? {}).map(([name, value]) => ({
    name,
    value,
  }));
  const status = post !== undefined && post.status !== 0 ? post.status : undefined;
  return {
    id: generateHistoryId(),
    kind: 'mcp',
    at: new Date().toISOString(),
    projectId,
    requestId: record.requestId,
    requestName: record.requestName,
    interfaceName: record.serverName,
    operationName: record.folderPath,
    endpoint: transport.type === 'stdio' ? commandDisplay(transport.command, transport.args) : transport.url,
    soapVersion: 'none',
    method: redacted.method,
    ...(status !== undefined ? { status } : {}),
    durationMs: redacted.durationMs,
    ok:
      redacted.failure === undefined && answered && redacted.error === undefined && !mcpResultIsError(redacted.result),
    request: { envelopeXml: sent?.text ?? '', headers: requestHeaders },
    ...(answered
      ? {
          response: {
            envelopeXml: answer?.text ?? '',
            rawHeaders: Object.entries(post?.responseHeaders ?? {}),
            status: status ?? 0,
            statusText: '',
          },
        }
      : {}),
    ...(redacted.failure !== undefined ? { error: redacted.failure } : {}),
    mcp,
    sizeBytes: redacted.messages.reduce((sum, message) => sum + message.size, 0),
    ...(record.tags !== undefined ? { tags: record.tags } : {}),
  };
}
